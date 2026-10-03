# 练功房自学教材

本目录是系统学习正文和专项练习关联阅读的内容来源。每个知识点单独编辑，界面不再在 React 组件中拼接教材正文。

## 目录

- `manifest.json`：九个体系的卡片、阶段、知识点顺序及文档路径。保留既有知识点 ID，练习和知识之间的链接继续有效。
- `documents/<体系>/<知识点 ID>.json`：正文、学习目标、分节讲解、乐器差异、步骤、例子、问题排查、自检和来源。
- `scores/*.musicxml`：文章中的原创谱例。所有谱面经统一 MusicXML 阅读器显示。
- `diagrams/*.svg`：非谱面的辅助图，例如键盘位置、信号路径、包络与动作关系。谱面不要另画成图片或表格。

文档格式见 `src/renderer/src/woodshed/lesson-document.ts`。`contexts` 的键为 `guitar-electric`、`guitar-acoustic`、`bass`、`ukulele`、`drums`、`piano`、`keyboard`。共享体系提供全部乐器情境；吉他体系提供电吉他和原声吉他。可在情境内覆盖例子与步骤。`scores`、`diagrams` 中的 `instruments` 限定适用标签；省略表示通用。

## 加载与维护

`knowledge.ts` 只读取目录索引，`lesson-library.ts` 用 Vite 的静态目录发现与动态导入按文章加载 JSON 和 MusicXML。只进入路线图不会加载全部教材正文或排版引擎。图片作为本地构建资源引入；发布构建会把文档、谱例和图片一起打包，可离线阅读。没有远程正文请求。

这是仓库中的可编辑教材源目录。修改后开发环境会更新；发布版要重新构建，直接修改已安装应用旁边的同名文件不会覆盖已打包教材。首次建立新目录或批量添加文件后，如开发服务还保留旧目录结果，应重新启动开发服务。不要把这些源文件理解为未经索引发现的任意用户文件加载入口。

新增知识点时，先添加文档，再在索引中登记，并根据需要添加专项练习的 `knowledge` 关联。不要复用其他知识点 ID。练习中的乐谱仍由练习事件生成 MusicXML，这样播放时序、音高、指法与谱面共享一个来源；它们与本目录的静态讲解谱例共用阅读器。

## 写作与音乐约定

正文按概念、推导、具体操作、可听见的差异和问题诊断展开。不要以重复的练习口号替代知识细节。设备篇明确适用条件，电吉他的音箱、箱体与失真链路不能默认套用到原声吉他。无固定音高的鼓通过聆听、节奏和配器理解音高理论，不虚构鼓件的固定音名。

科学音高名称以中央 C=C4 为准。谱例说明实际发声或八度移调约定；贝斯、吉他与高 G 尤克里里的音域必须分别核对。读谱需要节奏和音高同时清楚，五线谱、TAB、打击乐及钢琴大谱表均使用 MusicXML。MusicXML 格式以 [W3C MusicXML 4.0](https://www.w3.org/2021/06/musicxml40/) 为依据。

## 验证

```text
pnpm typecheck
pnpm exec vitest run tests/woodshed-lesson-library.test.ts tests/woodshed-learning.test.tsx tests/woodshed-practice.test.tsx tests/woodshed-musicxml.test.ts tests/ensemble-curriculum.test.ts
node scripts/verify-learning-musicxml.mjs
pnpm exec electron-vite build
```

还需浏览器检查：体系卡片 → 路线图 → 正文、七种乐器标签、电/原声吉他往返练习、谱例排版、播放高亮、内部谱面滚动及窄窗口。自动校验确认文档覆盖与谱面结构，不代替所有演奏技法的真人演示、教师审稿或音频设备验收。
