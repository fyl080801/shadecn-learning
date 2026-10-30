import { DIRECTOR_LIMITS, DIRECTOR_NODE_TYPE } from '@shadecn/shared/director-doc'
import { TOOL_LIMITS } from '../../tools.ts'
import { defineSkill } from '../registry.ts'
import { createDirectorTools } from './tools.ts'

export { createDirectorTools, DIRECTOR_READ_TOOL_NAMES, DIRECTOR_WRITE_TOOL_NAMES } from './tools.ts'

/**
 * 导演台技能 `director`：写 + 量（docs/07 §7.3.1–§7.3.2，docs/23 §4）。全是网关工具，不要 `sandbox:exec`、不要渲染服务，
 * 任何部署都能用。`auto`：会话绑定的是导演台节点、或用户这条消息 `@` 了导演台节点时一开始就加载，否则进技能目录。
 *
 * `requires` 比 docs/23 §4 的表多一项 `flow:delete`：`delete_director_elements` 和画布的删除类工具同一个口径
 * （`flow:delete`，花同一份每轮删除预算），注册表要求 `requires` 覆盖每个工具的能力。
 *
 * 看（`director-view`：渲染出图）还没做，所以提示段如实说「看不到画面」—— 等 `director-view` 上线，这句挪到它的可用条件里。
 */

const L = DIRECTOR_LIMITS

export const directorSkill = defineSkill({
  id: 'director',
  title: '导演台',
  summary: '编辑导演台节点里的 3D 场景与动画：新建 / 摆放 / 对齐几何体、机位、灯光，打关键帧、运动预设，并精确测量包围盒、距离、穿插和机位取景',
  prompt: `导演台（director 节点）里是一个可播放的 3D 场景：对象（几何体 box / sphere / cone / cylinder / plane、机位 camera、灯光 light）、轨道和关键帧。所有工具都要给 nodeId（导演台节点的 id）。场景只能用这里的工具读写，不能用 update_node 改 data 里的 dc.* 键。

坐标与单位：
- 单位一律是米、度、秒（存储时工具自己换算，你不用碰弧度和毫秒）。
- Y 轴向上，地面是 y = 0；对象的 position 是几何中心（不是底面），高沿 Y；plane 水平铺在 XZ 面、没有厚度。
- 旋转是欧拉角 [x, y, z]（度，XYZ 顺序）；机位朝它本地的 -Z 方向看，fov 是竖直视场角（度）。

工作方式：
1. 先 get_director_scene 了解现状、拿到真实的 id，再用原子操作搭建；引用只认 id，工具报「不存在」就重新读，不要猜。
2. 每一步看工具返回的数值（写入后的世界包围盒、尺寸、中心、底面高度），据此决定下一步。相对位置交给 place_object / align_objects / distribute_objects / aim_camera 算，不要自己心算坐标。
3. 摆完一批用 check_scene 查穿插、悬空、低于地面、出画；用 camera_view 查机位取景；按数值修正。
4. 尺寸、距离、是否穿插以测量（measure_objects / measure_distance / check_scene / camera_view）为准。球、圆锥、圆柱、斜放的对象按包围盒算，偏保守；机位、灯光没有体积。
5. 动画只打关键帧，不要逐帧烘焙：set_keyframes 只给关键时刻，常见运动用 animate_motion（orbit 绕圈、move_along 走路径、turn 转动、scale_to 缩放）让服务端生成稀疏帧。相邻两个旋转关键帧的转角必须小于 180°（插值走最短弧），大角度拆成多帧或用 turn。
6. 位置 / 旋转 / 缩放有关键帧时，transform_objects / place_object 改的是静态值，播放时被关键帧覆盖（结果里有提醒）；要改动画就改关键帧。测量和写入默认按 0 秒的状态，要看动画中的某一刻就给 t（秒）。

限额：批量参数一次最多 ${L.batch} 项，有一项不合格整个调用被拒、场景不变；每个导演台最多 ${L.objects} 个对象、${L.tracks} 条轨道、${L.keyframes} 个关键帧，时长最长 ${L.durationMs / 1000} 秒。delete_director_elements 点名的每个元素计 1 次删除，和画布删除共用每轮 ${TOOL_LIMITS.deletePerRun} 个的上限。

你这一轮看不到画面（还没有渲染出图的工具）：构图、比例只能靠测量判断，向用户说明时据实讲，不要描述你没看到的画面。`,
  tools: (ctx) => createDirectorTools(ctx),
  requires: ['flow:read', 'flow:write', 'flow:delete'],
  activation: 'auto',
  activatesFor: { nodeTypes: [DIRECTOR_NODE_TYPE] },
})
