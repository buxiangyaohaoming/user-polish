# user-polish — SillyTavern 用户润色插件

还在为输入框里的句子不够"像自己"而烦恼吗？**user-polish(润色插件)** 会记住你的表达习惯，把你要说的话润色成你最舒服的样子——你不用再复制粘贴给 AI 讲半天"我喜欢什么风格"。

## 它能做什么

🧠 **偏好画像(记忆)**
- 自动从你的历史消息中学习偏好——语气风格、用词习惯、人称方式、标点与篇幅偏好……
- 全局画像(所有对话共享) + 当前会话画像(仅本对话)分开管理，**更新时可自由选择更新哪个**

📌 **指定楼层截取**
- 手动勾选聊天中任意楼层，AI 只从你选中的内容里提取偏好(用户发言为重点,AI 发言作为语境参考)
- 一键"全选用户消息"、"清空选择"

✍️ **喜欢的段落**
- 贴一段你喜欢的文字/文风示例，AI 更新画像时会**结合这些段落与你以往的输入**一起分析

✨ **一键润色**
- 魔法棒菜单 → 润色输入框：根据画像润色并自动替换原文，原文自动进备份区
- 润色前弹确认框：可**临时输入参考内容**，或选择某条 **AI 发言作为风格参考**
- 润色模板完全可自定义({{profile}} {{char}} {{input}} 等占位符)

📊 **实时进度条**
- 流式请求实时显示进度与已生成字数，润色不再干等

🗃️ **备份区**
- 每次润色的原文自动备份，支持恢复原文 / 重新润色 / 删除

🔌 **多 API 支持**
- 默认使用酒馆当前 API；也可配置并保存多个 OpenAI 兼容预设(DeepSeek / OpenAI / 代理等)，可切换

🤖 **自动更新(可选)**
- 每 N 条新消息自动刷新画像，全程静默

📱 **移动端适配**
- PC 与手机(同一服务端)完全可用，触控尺寸已优化

## 安装

1. 把 `user-polish` 文件夹放入 SillyTavern 的 `data/<用户名>/extensions/` 目录
2. 或在扩展面板 → 安装扩展 → 输入仓库 URL
3. 扩展面板中启用"润色插件"，刷新页面(F5)

## 快速上手

1. 先发几条消息 → 魔法棒 → **更新画像**(可选:在配置界面勾选楼层 / 贴入喜欢的段落)
2. 输入一句话 → 魔法棒 → **润色输入框** → 确认 → 完成
3. 想微调 → **润色插件配置** 弹窗:改模板、加 API 预设、查看备份

## 注意事项

- API 密钥以明文保存在酒馆 settings.json 中并随账号同步，请勿在共享设备使用
- 生成画像/润色需 API 处于可用状态;预设接口跨域失败时可开启"经 ST 代理转发"

---

## English (Short)

**user-polish** — a SillyTavern extension that learns your writing style and polishes your input.

- Learns a **user preference profile** from your past messages (global + per-chat, update either independently)
- Pick specific **chat floors** as profile sources, or paste **sample paragraphs** you like
- One-click **polish** via the wand menu, with a confirmation dialog for custom **reference text** or choosing an **AI reply as style reference**
- Real-time **progress bar** (streaming), original text **backup** with restore/re-polish
- Custom **polishing templates**, multiple **API presets** (OpenAI-compatible), or use ST's current API
- Works on **PC & mobile**

Install: put the `user-polish` folder into `data/<user>/extensions/`, enable it in the Extensions panel, refresh.
