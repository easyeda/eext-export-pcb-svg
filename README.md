# 导出 PCB 为 SVG

将当前 PCB 文档一键导出为多个按层切分的 SVG 文件，并自动打包为 ZIP，方便测试、归档、二次编辑。

## 功能特性

- ✅ **按层拆分**：每个层（Top Layer、Bottom Layer、丝印层、阻焊层、文档层、机械层…）单独导出一个 SVG 文件
- ✅ **完整覆盖**：走线、圆弧、焊盘、过孔、铜皮填充、覆铜、丝印文本、禁布区、尺寸标注、属性、内嵌位图、器件参考点
- ✅ **几何保真**：基于 PCB 数据坐标（Y 轴向上）生成 SVG，通过 `viewBox` + `scale(1,-1)` 翻转 Y 轴，相对位置与画布完全一致
- ✅ **板框上下文**：除板框层外，每个层都附带板框描边作为参考
- ✅ **ZIP 打包**：全部 SVG 文件统一压缩到一个 ZIP，方便分发
- ✅ **一键导出当前板 / 批量导出工程下所有板**

## 文件命名规则

```
<板子名称>-<层名称>.svg
```

例如：

```
MyBoard-Top_Layer.svg
MyBoard-Bottom_Layer.svg
MyBoard-Top_Silkscreen.svg
MyBoard-Board_Outline.svg
```

ZIP 包名：

```
<板子名称>.zip
```

批量导出时的 ZIP 结构：

```
<工程下所有板子的合并>.zip
├─ BoardA/
│   ├─ BoardA-Top_Layer.svg
│   └─ ...
└─ BoardB/
    └─ ...
```

## 安装与使用

1. 打开 嘉立创EDA 专业版
2. 顶部菜单 → 扩展 → 本地扩展 → 选择 `build/dist/export-pcb-svg_v1.0.0.eext` 安装
3. 安装后重启客户端
4. 在 PCB 编辑器中点击菜单 **导出 PCB 为 SVG** → **导出当前板子为 SVG** 或 **导出所有板子为 SVG**
5. 浏览器会触发 ZIP 下载

## 菜单项

- `PCB` 编辑器菜单 → **Export PCB to SVG**
  - **Export Current Board to SVG...** — 导出当前打开的板子
  - **Export All Boards to SVG...** — 导出工程下所有板子

## 开发

```bash
# 安装依赖
npm install

# 开发模式（增量构建 + 监听）
npm run debug

# 生产构建 + 打包扩展包
npm run build

# 代码风格检查
npm run lint
```

打包后的产物在 `build/dist/export-pcb-svg_v1.0.0.eext`。

### 项目结构

```
src/
├─ index.ts            # 入口：菜单处理、数据采集、ZIP 打包、保存
├─ svg-exporter.ts     # 按层切分 SVG 的核心渲染器
├─ polygon.ts          # PCB 多边形（L / ARC / CARC / C / R / CIRCLE）→ SVG path d 转换
└─ zip-builder.ts      # 基于 JSZip 的浏览器端 ZIP 打包

locales/               # 多语言文案（i18n）
extension.json         # 扩展元数据 + 菜单注册
```

## SVG 与 PCB 坐标的对应关系

PCB 数据坐标：1 单位 = 1mil，Y 轴向上为正
SVG 屏幕坐标：Y 轴向下为正

为保持视觉一致，本扩展使用：

```xml
<svg viewBox="minX -maxY width height">
  <g transform="scale(1,-1)">
    <!-- 走线、焊盘等图元按 PCB 数据坐标绘制 -->
  </g>
</svg>
```

这样：(x, y) 数据点对应 SVG 中的 (x, −y) 屏幕点，几何相对位置完全一致。

## 实现要点

- **数据来源**：`eda.pcb_Primitive<Xxx>.getAll()` 一并获取走线、圆弧、焊盘、过孔、文本、填充、覆铜、区域、折线、位图、器件、尺寸标注
- **板框提取**：通过 `EPCB_LayerId.BOARD_OUTLINE (11)` 层的线段/圆弧图元构建
- **打包**：`JSZip.generateAsync({ type: 'blob', compression: 'DEFLATE' })`
- **保存**：`eda.sys_FileSystem.saveFile(blob, fileName)`

## 已知限制

- 器件内部封装（如丝印线条、铜皮）暂未展开为 SVG 子图元，仅在器件中心绘制一个虚线占位圆；如需完整器件外形可后续接入 `pcb_PrimitiveComponent.getAllPins()` 配合封装库逐图元展开
- 复杂多边形（折线、覆铜填充区域）依赖 PCB 多边形源数据格式，已覆盖 `L / ARC / CARC / C / R / CIRCLE` 模式
- 内嵌位图（`PCB_PrimitiveImage`）按多边形矢量绘制，未栅格化

## 开源许可

基于 [easyeda/pro-api-sdk](https://github.com/easyeda/pro-api-sdk)，遵循 Apache-2.0 许可协议。
