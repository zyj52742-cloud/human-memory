# -*- coding: utf-8 -*-
"""
scoring.py — 记忆评判标准 v0.2

设计依据（都是心理学里站得住的效应，不是拍脑袋）：

1. Russell 环形情绪模型：情绪用两个维度描述
   - 效价 valence：-1（极负面）~ +1（极正面）
   - 唤醒度 arousal：0（平静）~ 1（强烈）
   只用一个"正负"是分不出「平静地开心」和「狂喜」的。

2. 闪光灯记忆效应（flashbulb memory）：
   决定记忆强度的是情绪冲击力 = |效价| × 唤醒度。
   所以「暴怒」和「狂喜」都记得牢，「有点烦」和「还行」都不留痕。
   这修正了 v0.1 只给正情绪加分的漏洞。

3. 自我参照效应（self-reference effect）：关于"我"的信息记得更牢。

4. von Restorff 效应（独特性）：第一次、意外、反常的事更突出。

5. 复述/强化效应：反复出现的记忆权重更高（由引擎的 weight 字段负责）。

6. 情绪记忆更持久：高情绪冲击的记忆衰减更慢（半衰期翻倍）。
"""

from __future__ import annotations

import re

# ==========================================================================
# 一、情绪词典：词 -> (效价, 唤醒度)
# ==========================================================================

EMOTION_LEXICON: dict[str, tuple[float, float]] = {
    # ---- 高唤醒 · 正向 ----
    "兴奋": (0.9, 0.9), "激动": (0.9, 0.9), "惊喜": (0.9, 0.85),
    "开心": (0.8, 0.7), "高兴": (0.8, 0.7), "快乐": (0.85, 0.7),
    "幸福": (0.9, 0.7), "骄傲": (0.8, 0.7), "感动": (0.8, 0.6),
    "期待": (0.6, 0.6), "狂喜": (1.0, 1.0), "爽": (0.7, 0.7),
    # ---- 低唤醒 · 正向 ----
    "满足": (0.7, 0.3), "温暖": (0.7, 0.3), "安心": (0.6, 0.2),
    "放松": (0.5, 0.15), "舒服": (0.6, 0.2), "平静": (0.3, 0.1),
    "踏实": (0.5, 0.2), "还行": (0.3, 0.1),
    # ---- 高唤醒 · 负向 ----
    "愤怒": (-0.9, 0.9), "生气": (-0.8, 0.8), "暴躁": (-0.8, 0.85),
    "烦躁": (-0.6, 0.7), "焦虑": (-0.7, 0.8), "紧张": (-0.5, 0.8),
    "害怕": (-0.8, 0.85), "恐惧": (-0.9, 0.9), "惊恐": (-0.95, 0.95),
    "崩溃": (-0.95, 0.95), "绝望": (-0.95, 0.85), "羞耻": (-0.8, 0.8),
    "尴尬": (-0.6, 0.7), "内疚": (-0.7, 0.6), "后悔": (-0.6, 0.6),
    "委屈": (-0.6, 0.6), "心疼": (-0.8, 0.7), "讨厌": (-0.7, 0.8),
    "恨": (-0.9, 0.9), "烦": (-0.5, 0.6), "恶心": (-0.8, 0.7),
    "嫉妒": (-0.6, 0.7), "抓狂": (-0.9, 0.9), "心慌": (-0.7, 0.8),
    # ---- 低唤醒 · 负向 ----
    "难过": (-0.8, 0.5), "伤心": (-0.85, 0.5), "失落": (-0.7, 0.35),
    "孤独": (-0.7, 0.4), "沮丧": (-0.7, 0.4), "失望": (-0.7, 0.45),
    "疲惫": (-0.5, 0.3), "累": (-0.4, 0.35), "无聊": (-0.3, 0.15),
    "麻木": (-0.5, 0.1), "想哭": (-0.8, 0.6), "叹气": (-0.5, 0.3),
    "孤单": (-0.7, 0.4), "委屈巴巴": (-0.6, 0.5),
    # ---- 口语 / 状态描述（日常真实说法） ----
    "气死了": (-0.9, 0.9), "烦死了": (-0.7, 0.8), "累死了": (-0.5, 0.5),
    "爽死了": (0.9, 0.9), "开心死了": (0.9, 0.9), "难受": (-0.5, 0.5),
    "低落": (-0.6, 0.3), "提不起劲": (-0.5, 0.2), "提不起精神": (-0.5, 0.2),
    "没精神": (-0.5, 0.2), "心累": (-0.6, 0.4), "撑不住": (-0.7, 0.6),
    "糟心": (-0.6, 0.4), "无语": (-0.4, 0.4), "无奈": (-0.4, 0.2),
    "憋屈": (-0.6, 0.5), "想放弃": (-0.7, 0.4), "缓不过来": (-0.6, 0.35),
    "不在状态": (-0.4, 0.2), "缓过来了": (0.3, 0.2),
    # ---- 依恋类 ----
    "爱": (0.9, 0.7), "喜欢": (0.8, 0.6), "想念": (0.7, 0.5),
    "舍不得": (0.3, 0.5), "担心": (-0.5, 0.6),
}

# 程度加强词 / 减弱词 / 否定词
INTENSIFIERS_UP = ["非常", "特别", "超级", "极其", "十分", "格外", "相当",
                   "太", "死了", "极了", "得要命", "不行了", "爆了"]
INTENSIFIERS_DOWN = ["有点", "稍微", "略微", "有些", "一点点", "微微", "还"]
NEGATIONS = ["不", "没", "别", "无", "未"]

# ==========================================================================
# 二、记忆类型与衰减
# ==========================================================================

# 类型 -> 半衰期（天）。身份和边界几乎不淡，事件和习惯淡得快。
DECAY_HALF_LIFE = {
    "identity": 3650.0,
    "boundary": 3650.0,
    "grudge": 36500.0,
    "relationship": 730.0,
    "preference": 365.0,
    "goal": 180.0,
    "fact": 120.0,
    "habit": 90.0,
    "mood": 21.0,
    "emotion": 30.0,
    "event": 10.0,
}

KIND_LABEL = {
    "identity": "身份",
    "boundary": "边界",
    "grudge": "心结",
    "relationship": "关系",
    "preference": "偏好",
    "goal": "目标",
    "fact": "事实",
    "habit": "习惯",
    "mood": "情绪状态",
    "emotion": "情绪",
    "event": "事件",
}

# ==========================================================================
# 三、六因子重要性权重
# ==========================================================================

BASE = 0.25          # 基础分：任何值得记的话至少这么多
W_SELF = 0.28        # 自我参照
W_EMOTION = 0.30     # 情绪冲击（最重要）
W_SOCIAL = 0.12      # 社会关系
W_IDENTITY = 0.10    # 身份/目标
W_NOVELTY = 0.08     # 新奇意外
W_DETAIL = 0.05      # 细节丰富
W_STATE = 0.10       # 情绪状态持续性（今天累、心情低落这类日常状态）

# 情绪强度分界线：低于此算"状态"（mood），高于此算"事件"（emotion）
EMOTION_EVENT_THRESHOLD = 0.35

RELATION_WORDS = [
    "女儿", "儿子", "孩子", "爸爸", "妈妈", "父亲", "母亲", "老公", "老婆",
    "丈夫", "妻子", "对象", "男朋友", "女朋友", "朋友", "闺蜜", "同事",
    "老板", "领导", "老师", "同学", "家人", "亲人", "奶奶", "爷爷", "外婆", "外公",
]

IDENTITY_PAT = re.compile(r"我叫|我是|我住|我今年|我生日|我在.{0,8}(?:工作|上班|读书|上学)|我干|我做")
GOAL_PAT = re.compile(r"想|打算|计划|希望|梦想|愿望|准备|以后|将来|目标|要(?:去|学|做|交|完成|考)")
NOVELTY_PAT = re.compile(r"第一次|头一次|头一回|从来没|以前没|从没|突然|竟然|居然|没想到|想不到|意外|破天荒")
BOUNDARY_PAT = re.compile(r"别问|别提|不要说|不能提|忌讳|雷区|敏感话题|不想聊|别跟我提")

# 心结：赌气、冷战、过不去的事。不会自动淡去，必须被"化解"才算完。
GRUDGE_PAT = re.compile(
    r"赌气|冷战|过不去|想不开|耿耿于怀|还气着|没消气|记仇|闹别扭|没和好|没和解"
    r"|还(?:在)?生.{0,3}气|还憋着|心里堵着|放不下|咽不下|不服气|憋屈"
)

# 化解信号：说了这些，说明心结可以放下了
RESOLVE_PAT = re.compile(
    r"过去了|想开了|不气了|和好了|和解了|原谅|没事了|放下了|不介意了|气消了|翻篇了|说开了"
)
HABIT_PAT = re.compile(r"每天|每周|总是|经常|习惯|老是|天天")
PREFS = ["喜欢", "讨厌", "爱吃", "吃不惯", "不爱", "受不了", "过敏", "最爱", "怕"]


# ==========================================================================
# 四、情绪识别
# ==========================================================================

def detect_emotion(text: str) -> tuple[float, float, str]:
    """返回 (效价, 唤醒度, 命中的情绪词)。取情绪冲击最强的那个词。"""
    best = (0.0, 0.0, "")
    best_salience = -1.0

    for word, (base_v, base_a) in EMOTION_LEXICON.items():
        idx = text.find(word)
        while idx != -1:
            pre = text[max(0, idx - 5):idx]
            post = text[idx + len(word): idx + len(word) + 3]
            # 净化片段：避免「特别/分别/告别」里的「别」被误判成否定
            pre_clean = pre
            for safe in ("特别", "区别", "分别", "告别", "类别", "级别"):
                pre_clean = pre_clean.replace(safe, safe[0])
            v, a = base_v, base_a

            if any(d in pre for d in INTENSIFIERS_DOWN):
                # 有点 / 稍微 / 还：情绪被稀释
                a = base_a * 0.55
                v = base_v * 0.85
            elif any(n in pre_clean for n in NEGATIONS):
                # 不开心 / 没生气：效价反转并减弱
                v = -base_v * 0.8
                a = base_a * 0.9
            elif any(u in pre or u in post for u in INTENSIFIERS_UP):
                # 非常 / 特别 / 死了：强度拉满
                a = min(1.0, base_a * 1.35)
                v = base_v * 1.1

            v = max(-1.0, min(1.0, v))
            a = max(0.0, min(1.0, a))
            salience = abs(v) * a
            if salience > best_salience:
                best_salience = salience
                best = (round(v, 3), round(a, 3), word)

            idx = text.find(word, idx + 1)

    return best


# ==========================================================================
# 五、六因子打分
# ==========================================================================

def _detail_score(text: str) -> float:
    n = len(text)
    if n >= 60:
        return 1.0
    if n >= 30:
        return 0.5
    if n >= 15:
        return 0.2
    return 0.0


def _classify_kind(text: str, salience: float, emotion_word: str = "") -> str:
    if BOUNDARY_PAT.search(text):
        return "boundary"
    if GRUDGE_PAT.search(text):
        return "grudge"
    if any(w in text for w in PREFS):
        return "preference"
    if salience >= 0.50:
        # 强情绪事件优先于"提到了谁"，但偏好词仍归偏好
        return "emotion"
    if IDENTITY_PAT.search(text):
        return "identity"
    if any(w in text for w in RELATION_WORDS):
        return "relationship"
    if GOAL_PAT.search(text):
        return "goal"
    if HABIT_PAT.search(text):
        return "habit"
    if emotion_word:
        # 强烈情绪算"事件"，低唤醒的情绪算"状态"——状态才是判断心情的基线
        return "emotion" if salience >= EMOTION_EVENT_THRESHOLD else "mood"
    if re.search(r"(?:去|到|在|从|给|跟|买|吃|看|玩|见|聊|做).{0,8}(?:了|过)", text):
        return "event"
    return "fact"


def score_text(text: str) -> dict:
    """完整评分。返回 importance / 类型 / 情绪 / 六因子明细。"""
    text = (text or "").strip()

    v, a, emo_word = detect_emotion(text)
    salience = round(abs(v) * a, 3)

    self_ref = 1.0 if ("我" in text or "自己" in text or "咱" in text) else 0.0

    social = 0.0
    if any(w in text for w in RELATION_WORDS):
        social = 0.7
        if re.search(r"最(?:爱|重要|喜欢|疼|亲)|唯一|离不开", text):
            social = 1.0

    identity = 1.0 if (IDENTITY_PAT.search(text) or GOAL_PAT.search(text)) else 0.0
    novelty = 1.0 if NOVELTY_PAT.search(text) else 0.0
    detail = _detail_score(text)

    kind = _classify_kind(text, salience, emo_word)
    state = 1.0 if kind in ("mood", "emotion") else 0.0
    if kind in ("identity", "boundary", "relationship") and text.startswith(("我", "咱")):
        identity = max(identity, 1.0)

    importance = round(min(1.0, (
        BASE
        + W_SELF * self_ref
        + W_EMOTION * salience
        + W_SOCIAL * social
        + W_IDENTITY * identity
        + W_NOVELTY * novelty
        + W_DETAIL * detail
        + W_STATE * state
    )), 3)

    return {
        "importance": importance,
        "kind": kind,
        "valence": v,
        "arousal": a,
        "salience": salience,
        "emotion_word": emo_word,
        "decay_class": kind,
        "half_life": decay_half_life(kind, salience),
        "aftermath": aftermath_days(kind, salience),
        "breakdown": {
            "base": BASE,
            "self": self_ref,
            "emotional": salience,
            "social": social,
            "identity": identity,
            "novelty": novelty,
            "detail": detail,
            "state": state,
            "weights": {
                "self": W_SELF, "emotional": W_EMOTION, "social": W_SOCIAL,
                "identity": W_IDENTITY, "novelty": W_NOVELTY, "detail": W_DETAIL,
                "state": W_STATE,
            },
        },
    }


def decay_half_life(kind: str, salience: float) -> float:
    """半衰期（天）。情绪冲击强的记忆衰减更慢（闪光灯效应）。"""
    base = DECAY_HALF_LIFE.get(kind, 120.0)
    if salience >= 0.50:
        return base * 2.0
    if salience >= 0.25:
        return base * 1.5
    return base


def aftermath_days(kind: str, salience: float) -> float:
    """余波期（天）：一件事发生之后，还会影响状态多久。

    对应「有事情很多天都过不去」：冲击越强，余波越久。
    心结不设期限，靠"化解"结束。
    """
    if kind == "grudge":
        return 36500.0
    if kind == "emotion" and salience >= 0.50:
        return round(3.0 + salience * 8.0, 1)
    return 0.0


def explain(data: dict) -> str:
    """把评分明细格式化成人类可读文本。"""
    b = data["breakdown"]
    w = b["weights"]

    def line(name, value, weight):
        return f"  {name:<6} {value:.2f} × {weight:.2f} = {value * weight:.3f}"

    parts = [
        f"  基础分  {b['base']:.2f}",
        line("自我", b["self"], w["self"]),
        line("情绪", b["emotional"], w["emotional"]),
        line("社会", b["social"], w["social"]),
        line("身份", b["identity"], w["identity"]),
        line("新奇", b["novelty"], w["novelty"]),
        line("细节", b["detail"], w["detail"]),
        line("状态", b.get("state", 0), w.get("state", 0)),
        f"  ---------- 合计 = {data['importance']:.3f}（封顶 1.0）",
        f"  类型：{KIND_LABEL.get(data['kind'], data['kind'])}（{data['kind']}）",
        f"  情绪：效价 {data['valence']:+.2f} / 唤醒 {data['arousal']:.2f}"
        + (f" / 冲击力 {data['salience']:.2f}（{data['emotion_word']}）" if data.get("emotion_word") else ""),
        f"  衰减：半衰期 {data['half_life']:.0f} 天",
    ]
    return "\n".join(parts)


if __name__ == "__main__":
    # 自检：几组对照，看是否符合直觉
    samples = [
        "我叫林小满，我讨厌香菜，闻到就想吐",
        "我女儿叫小满，今年五岁，在学钢琴",
        "今天加班到十点，累死了",
        "明天要交周报，还没写完",
        "我特别焦虑，感觉要崩溃了",
        "今天心情还算平静",
        "这是我第一次拿奖学金，太激动了",
        "别问我前女友的事，我不想聊",
        "我每天早上六点跑步",
        "我想明年去学钢琴",
    ]
    print(f"{'重要度':<7}{'类型':<10}{'情绪冲击':<9}文本")
    print("-" * 72)
    for s in samples:
        d = score_text(s)
        print(f"{d['importance']:<8.3f}{d['kind']:<12}{d['salience']:<9.2f}{s}")
    print()
    print("明细示例：")
    print(explain(score_text("我叫林小满，我讨厌香菜，闻到就想吐")))
