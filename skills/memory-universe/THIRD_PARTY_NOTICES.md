# 第三方组件与素材来源（memory-universe 技能）

本技能目录可单独复制使用，所以许可声明也随目录携带。项目主体许可见同目录 `LICENSE`。

## Three.js

- 文件：`assets/_lib/three.min.js`
- 版本：r160 UMD 构建（文件内注释标注 r160；`memory-webgl.js` 按 r160 API 编写）
- 版权：`Copyright 2010-2023 Three.js Authors`
- 许可：MIT（文件头含 `SPDX-License-Identifier: MIT`）
- 项目主页：<https://github.com/mrdoob/three.js>
- 用途：两个三维视图的 WebGL 渲染；文件原样分发，未修改。

```text
MIT License

Copyright 2010-2023 Three.js Authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## 行星纹理

- 文件：`assets/_lib/tex_procedural.js`
- 来源：本技能自带代码，在浏览器里用 canvas 程序化生成 13 个世界的纹理。
- 许可：与项目一致，MIT。
- 边界：这是**程序化近似纹理**（条带、陨石坑、极冠、云层等），不是真实天文照片，也不含任何外部图片或网络请求。

## 视图渲染代码

`assets/_lib/atlas.js`、`assets/_lib/atlas.css`、`assets/_lib/memory-webgl.js` 与两个页面模板均为本项目代码，随本技能以 MIT 分发。

## 截图与示例数据

本技能不附带真实用户截图、真实记忆库或真实对话导出。`universe.py demo` 生成的对话、记忆、实体、事件全部为合成示例。
