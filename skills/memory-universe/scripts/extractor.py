# -*- coding: utf-8 -*-
"""
extractor.py — 记忆抽取层（规则版 / 模型版）

两种模式：
1. 规则版（默认）：scoring.score_text，零成本、零联网、离线可用
2. 模型版（可选）：调用 OpenAI 兼容接口，理解隐性表达

模型版靠三个环境变量启用，缺一个就自动回落规则版：
    MEMORY_LLM_BASE_URL   例如 https://api.deepseek.com/v1
    MEMORY_LLM_API_KEY    你的密钥（不会写进代码或日志）
    MEMORY_LLM_MODEL      例如 deepseek-chat

设计要点：
- 模型只输出「因子分」，重要度仍由公式算 → 保持可解释、可对比
- 任何异常（网络、超时、JSON 坏、字段缺失）都回退规则版，绝不丢记忆
- 用标准库 urllib，不引入第三方依赖
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

import scoring

FACTOR_KEYS = ("self", "emotional", "social", "identity", "novelty", "detail", "state")
KINDS = set(scoring.KIND_LABEL.keys())

PROMPT = """你是记忆评判器。分析下面这句话，判断它值不值得记住、有多重要。

句子：{text}

请从以下维度打分（都是 0.0~1.0 的小数）：
- self：是否在说说话者自己的事
- emotional：情绪冲击有多强（平静=0，暴怒或狂喜=1）
- social：是否涉及重要他人（家人、伴侣、孩子、密友）
- identity：是否涉及身份或长期目标
- novelty：是否意外、第一次、反常
- detail：细节是否丰富
- state：是否是持续的心理状态（疲惫、低落、焦虑等日常状态）
- valence：情绪正负，-1.0 极负面 到 1.0 极正面
- arousal：情绪强度，0.0 平静 到 1.0 强烈
- kind：从 identity/boundary/grudge/preference/relationship/goal/habit/mood/emotion/event/fact 里选一个
- trigger_terms：2 到 6 个词，以后用来想起这条记忆

格式示例（注意：这里示范的是**另一句话**，只说明格式，不要照抄这个内容）：
句子：我昨天去公园散步
输出：{{"self":1.0,"emotional":0.1,"social":0.0,"identity":0.0,"novelty":0.0,"detail":0.3,"state":0.0,"valence":0.2,"arousal":0.1,"kind":"event","trigger_terms":["公园","散步"]}}

现在请分析**第一句**「{text}」，只输出 JSON，不要任何解释：
"""


def _config() -> tuple[str, str, str] | None:
    base = os.environ.get("MEMORY_LLM_BASE_URL", "").strip()
    key = os.environ.get("MEMORY_LLM_API_KEY", "").strip()
    model = os.environ.get("MEMORY_LLM_MODEL", "").strip()
    if base and key and model:
        return base, key, model
    return None


def enabled() -> bool:
    return _config() is not None


def _call_llm(prompt: str, base: str, key: str, model: str,
              timeout: float = 120.0) -> str:
    url = base.rstrip("/") + "/chat/completions"
    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0,
        # 必须限长：小模型容易陷入循环输出，不限的话会一直生成到上下文上限
        "max_tokens": 400,
    }).encode("utf-8")
    req = urllib.request.Request(
        url, data=body,
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {key}"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return data["choices"][0]["message"]["content"]


def _parse_json(raw: str) -> dict:
    text = raw.strip()
    if text.startswith("```"):
        text = text.split("```")[1]
        if text.startswith("json"):
            text = text[4:]
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1:
        raise ValueError("没有 JSON 结构")
    return json.loads(text[start:end + 1])


def _clamp(x, lo=0.0, hi=1.0) -> float:
    try:
        return max(lo, min(hi, float(x)))
    except (TypeError, ValueError):
        return 0.0


def _merge(base: dict, llm: dict, text: str) -> dict:
    """模型只改因子分和类型，重要度仍由公式算。"""
    b = dict(base["breakdown"])
    weights = dict(b.get("weights") or {})

    for k in FACTOR_KEYS:
        if k in llm:
            b[k] = _clamp(llm[k])

    kind = llm.get("kind") if llm.get("kind") in KINDS else base["kind"]
    valence = _clamp(llm.get("valence", base["valence"]), -1.0, 1.0)
    arousal = _clamp(llm.get("arousal", base["arousal"]))
    salience = round(abs(valence) * arousal, 3)

    importance = b.get("base", 0.25) + sum(
        b.get(k, 0.0) * weights.get(k, 0.0) for k in FACTOR_KEYS
    )
    importance = round(min(1.0, importance), 3)

    terms = llm.get("trigger_terms")
    if not isinstance(terms, list) or not terms:
        terms = base.get("trigger_terms") or []
    terms = [str(t).strip() for t in terms if str(t).strip()][:12]

    result = dict(base)
    result.update({
        "importance": importance,
        "kind": kind,
        "valence": round(valence, 3),
        "arousal": round(arousal, 3),
        "salience": salience,
        "emotion_word": base.get("emotion_word", ""),
        "decay_class": kind,
        "half_life": scoring.decay_half_life(kind, salience),
        "aftermath": scoring.aftermath_days(kind, salience),
        "breakdown": b,
        "trigger_terms": terms,
        "extractor": "llm",
    })
    return result


def extract(text: str) -> dict:
    """统一入口：能用模型就用，不能用或出错都回退规则版。"""
    base = scoring.score_text(text)
    base["extractor"] = "rule"
    base.setdefault("trigger_terms", [])

    cfg = _config()
    if not cfg:
        return base

    base_url, api_key, model = cfg
    try:
        raw = _call_llm(PROMPT.format(text=text), base_url, api_key, model)
        parsed = _parse_json(raw)
        return _merge(base, parsed, text)
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        sys.stderr.write(f"[memory] 模型抽取失败（网络），回退规则版：{e}\n")
    except (json.JSONDecodeError, KeyError, ValueError, TypeError) as e:
        sys.stderr.write(f"[memory] 模型输出不可用，回退规则版：{e}\n")
    return base


if __name__ == "__main__":
    print("模型版是否启用：", enabled())
    for s in ["我讨厌香菜，闻到就想吐", "说不上来哪里不对，心里堵得慌"]:
        d = extract(s)
        print(f"  [{d['extractor']}] {d['importance']:.2f} {d['kind']:10s} {s}")
