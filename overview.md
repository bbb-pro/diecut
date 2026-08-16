# T004A 3D 折叠修复 — 会话总结

## 问题
用户反馈 T004A「上盖插舌结构」盒型的 3D 折叠预览「底部不对，折叠也不对」。

## 根因
前次会话引入的静态铰链（static hinge）方案中，`foldMult=0` 被 JavaScript falsy 逻辑覆盖：
```js
var mult = h.foldMult || 1;  // 0 || 1 → 1 ❌
```
导致 F11-F12 前墙拼接处的静态铰链仍旋转 90°，前墙断裂，进而使附着于 F12 的底部翻片 F14 位置异常。

## 修复
1. **falsy-0 bug 修复**（preview3d.js line 74）
   - 改为 `var mult = (h.foldMult == null) ? 1 : h.foldMult;`
   - F12 正确保持与 F11 共面，前墙连续。

2. **WebGL 截图黑屏修复**（preview3d.js line 692）
   - 添加 `preserveDrawingBuffer: true`，支持 headless 截图验证。

3. **弧线压痕提取修复**（preview3d.js line 765）
   - arc 数据 `[cx, cy, r, sa, ea]` 原被误读为两个端点。
   - 改为展开为 polyline 点列，与 `reconstructFacesFromFE` 保持一致。

## 验证
- 多角度浏览器截图确认：
  - 底部翻片（F5/F2/F10/F14）均向内折叠，无外翻
  - 前墙 F11+F12 连续，胶贴 F16 折向内侧
  - JP012 回归测试正常

## 截图
- `_test_v18_default.png` — 默认视角完全折叠
- `_test_v18_bottom.png` — 底部仰视
- `_test_left_side.png` — 左侧视
- `_test_front_view.png` — 前视
