# 第三方组件与素材来源

本仓库主体以 MIT 许可发布（见 `LICENSE`）。`skills/memory-universe/` 可单独复制使用，因此它自带一份 `LICENSE` 与 `THIRD_PARTY_NOTICES.md`；完整组件清单、Three.js MIT 全文与素材边界以该文件为准：

**[skills/memory-universe/THIRD_PARTY_NOTICES.md](skills/memory-universe/THIRD_PARTY_NOTICES.md)**

## 组件概览

| 组件 | 位置 | 许可 / 来源 |
|---|---|---|
| Three.js r160 UMD | `skills/memory-universe/assets/_lib/three.min.js` | MIT，Copyright 2010-2023 Three.js Authors，[上游](https://github.com/mrdoob/three.js) |
| 行星纹理 | `skills/memory-universe/assets/_lib/tex_procedural.js` | 本项目代码用 canvas 本地生成，MIT；不含外部图片 |
| 视图渲染代码 | `assets/_lib/atlas.js`、`atlas.css`、`memory-webgl.js` | 本项目代码，MIT |

## 素材边界

- 行星纹理是**程序化生成的近似纹理**（条带、陨石坑、极冠、云层等），不是真实天文照片，也不是任何机构的实拍素材。
- 仓库不包含真实用户截图、真实记忆库或真实对话导出；demo 数据全部为合成示例。
- 两个页面只使用系统字体和本地资源，不引用 CDN、远程字体、远程图片或统计脚本。
