# Windows安装模板来源

`installer.nsi`基于[Tauri tauri-cli-v2.12.2](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.2/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi)，原始SHA-256为`166f9677d42e81c7f712a1bf80d9d8c089c21d2967d8398474768b5eac14b494`。上游提供Apache-2.0或MIT许可，完整声明见[MIT](LICENSE-MIT)与[Apache-2.0](LICENSE-APACHE-2.0)。

本项目的修改仅分离固定安装标识与显示名称，并在目标匹配时清理旧名称快捷方式。注册表、既有安装位置及应用数据标识保持兼容；资源与版本仍由Tauri构建参数装配。此声明不改变本项目其他代码的许可状态。
