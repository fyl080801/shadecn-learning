import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ops from "@shadecn/shared/flow-ops";
import { defineComponent, h, nextTick, ref, shallowRef } from "vue";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import * as Y from "yjs";
import { nodeGroup } from "@shadecn/shared/flow-doc";
import {
  GRAPH_SCHEMA_VERSION,
  type FlowNodeRecord,
} from "@shadecn/shared/flow-graph";
import { buildNodeRecord } from "@shadecn/shared/flow-node-types";
import type { FlowDetail } from "@shadecn/shared/canvas";
import { useFlowStore } from "@/stores/flow";
import NodeHost from "@/components/flow/node-kit/NodeHost.vue";
import {
  createNodeKitRuntime,
  NODE_KIT_KEY,
} from "@/components/flow/node-kit/context";
import { createDefaultNodeKit } from "@/components/flow/node-kit/install";
import { nodeKitGlobal } from "./node-kit/with-kit";

/**
 * 画布上的节点（宿主 `NodeHost` + 默认注册表里的类型与能力）：运行态的展示、按端口声明 + 节点数据画连接点（分组不画）、
 * 连线方向（入口不能起拉、没有加号；出口的加号弹候选菜单）、改名经 `useFlowNode` 写到 `metadata.label`、分组的解组、
 * 文本的就地编辑、图片 / 视频 / 导演台各自的 body。
 *
 * 数据走真的 store + Y.Doc（`useFlowNode` 直接读 store）；Vue Flow 那几个要画布上下文的组件
 * （Handle / NodeToolbar / NodeResizer）换成只渲染自己的替身 —— 这里测的是基础组件交给它们什么，
 * 不是 Vue Flow 本身。
 */

const selectOnly = vi.fn();
/** 画布缩放：媒体节点按它取缩略图档 */
const zoomLevel = ref(1);
const openGrowMenu = vi.fn();
const deleteNode = vi.fn();
const selectedNodeId = ref<string | null>(null);
const uploadAsset = vi.fn();
const captureVideoPoster = vi.fn();
const isValidConnection = vi.fn(
  (_connection: { source: string; target: string }) => true,
);
/** 正在拉线的起点（Vue Flow 的 `connectionStartHandle`）；null = 没在拉线 */
const connectionStartHandle = ref<{
  nodeId: string;
  type: "source" | "target";
  id: string | null;
} | null>(null);

vi.mock("@/lib/asset-upload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/asset-upload")>()),
  uploadFlowAsset: (...args: unknown[]) => uploadAsset(...args),
}));
vi.mock("@/lib/video-poster", () => ({
  captureVideoPoster: (...args: unknown[]) => captureVideoPoster(...args),
}));

vi.mock("@/composables/flow/editor-context", () => ({
  useFlowEditor: () => ({
    canvas: {
      selectOnly,
      openGrowMenu,
      deleteNode,
      duplicateNode: vi.fn(),
      growMenu: shallowRef(null),
      isValidConnection: (connection: { source: string; target: string }) =>
        isValidConnection(connection),
      boxSelecting: ref(false),
      zoomLevel,
    },
    presence: { occupantsOf: () => [] },
    selection: { selectedNodeId },
    flowId: ref("flow-1"),
    store: useFlowStore(),
  }),
}));

vi.mock("@vue-flow/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vue-flow/core")>();
  return {
    ...actual,
    useVueFlow: (...args: Parameters<typeof actual.useVueFlow>) => ({
      ...actual.useVueFlow(...args),
      connectionStartHandle,
    }),
    Handle: defineComponent({
      props: {
        id: { type: String, default: null },
        type: String,
        position: String,
        connectableStart: { type: Boolean, default: true },
        connectableEnd: { type: Boolean, default: true },
      },
      setup(props, { slots }) {
        return () =>
          h(
            "div",
            {
              "data-stub": "handle",
              "data-handle-id": props.id ?? "",
              "data-handle-type": props.type,
              "data-connectable-start": String(props.connectableStart),
              "data-connectable-end": String(props.connectableEnd),
            },
            slots.default?.(),
          );
      },
    }),
    useNodeConnections: () => ref([]),
  };
});

vi.mock("@vue-flow/node-toolbar", () => ({
  NodeToolbar: defineComponent({
    props: { isVisible: Boolean },
    setup(props, { slots }) {
      return () =>
        props.isVisible
          ? h("div", { "data-stub": "toolbar" }, slots.default?.())
          : null;
    },
  }),
}));

vi.mock("@vue-flow/node-resizer", () => ({
  NodeResizeControl: defineComponent({
    props: { nodeId: String, position: String, keepAspectRatio: Boolean, minWidth: Number, minHeight: Number },
    setup(props, { slots }) {
      return () =>
        h(
          "div",
          {
            "data-stub": "resizer",
            "data-node-id": props.nodeId,
            "data-position": props.position,
            "data-keep-ratio": String(props.keepAspectRatio),
            "data-min-width": String(props.minWidth),
          },
          slots.default?.(),
        );
    },
  }),
}));

function detail(): FlowDetail {
  return {
    id: "flow-1",
    projectId: "project-1",
    mode: "collab",
    name: "测试画布",
    description: null,
    status: "draft",
    tags: [],
    thumbnail: null,
    nodeCount: 0,
    edgeCount: 0,
    revision: 0,
    createdById: "user-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    graph: {
      schemaVersion: GRAPH_SCHEMA_VERSION,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [],
      edges: [],
      meta: {},
    },
    userState: {},
  };
}

function record(
  id: string,
  type: string,
  patch: Partial<FlowNodeRecord> = {},
): FlowNodeRecord {
  return {
    ...buildNodeRecord({
      id,
      type,
      label: `节点 ${id}`,
      position: { x: 0, y: 0 },
    }),
    ...patch,
  };
}

let wrapper: VueWrapper | null = null;

function setup(...nodes: FlowNodeRecord[]) {
  const store = useFlowStore();
  store.load(detail());
  const doc = new Y.Doc();
  store.attachDoc(doc);
  for (const node of nodes) store.addNode(node);
  return { store, doc };
}

/** Vue Flow 交给节点组件的那几个 props（只给组件真正读的） */
function nodeProps(id: string, type: string) {
  return { id, type, selected: false, data: {} } as never;
}

describe("画布节点", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    selectOnly.mockClear();
    openGrowMenu.mockClear();
    selectedNodeId.value = null;
    connectionStartHandle.value = null;
    isValidConnection.mockReset();
    isValidConnection.mockReturnValue(true);
  });
  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
  });

  it("runtime.status 为 processing：根元素标上状态并出现「运行中」角标，没有错误信息", () => {
    setup(record("n1", "process", { runtime: { status: "processing" } }));
    wrapper = mount(NodeHost, {
      global: nodeKitGlobal(),
      props: nodeProps("n1", "process"),
    });

    expect(wrapper.attributes("data-status")).toBe("processing");
    expect(
      wrapper.find('[data-testid="node-status-processing"]').text(),
    ).toContain("运行中");
    expect(wrapper.find('[data-testid="node-status-error"]').exists()).toBe(
      false,
    );
  });

  it("runtime.status 为 error：显示 runtime.error；没有错误文案时给兜底", async () => {
    const { store } = setup(
      record("n1", "process", {
        runtime: { status: "error", error: "模型超时" },
      }),
    );
    wrapper = mount(NodeHost, {
      global: nodeKitGlobal(),
      props: nodeProps("n1", "process"),
    });

    expect(wrapper.attributes("data-status")).toBe("error");
    expect(wrapper.find('[data-testid="node-status-error"]').text()).toBe(
      "模型超时",
    );
    expect(wrapper.classes()).toContain("flow-node-error");

    store.writeNode("n1", "runtime", { remove: ["error"] });
    await nextTick();
    expect(wrapper.find('[data-testid="node-status-error"]').text()).toBe(
      "运行出错",
    );
  });

  it("idle：既没有角标也没有错误信息；body 是类型外观里声明的那个", () => {
    setup(record("n1", "text"));
    wrapper = mount(NodeHost, {
      global: nodeKitGlobal(),
      props: nodeProps("n1", "text"),
    });

    expect(wrapper.attributes("data-status")).toBe("idle");
    expect(
      wrapper.find('[data-testid="node-status-processing"]').exists(),
    ).toBe(false);
    expect(wrapper.find('[data-testid="node-status-error"]').exists()).toBe(
      false,
    );
    expect(wrapper.find('[data-testid="text-body"]').text()).toBe(
      "双击输入文本",
    );
  });

  it("没声明端口的类型：左右各一个不带 id 的连接点", () => {
    setup(record("n1", "process"));
    wrapper = mount(NodeHost, {
      global: nodeKitGlobal(),
      props: nodeProps("n1", "process"),
    });

    const handles = wrapper.findAll('[data-stub="handle"]');
    expect(
      handles.map((item) => [
        item.attributes("data-handle-type"),
        item.attributes("data-handle-id"),
      ]),
    ).toEqual([
      ["target", ""],
      ["source", ""],
    ]);
  });

  it("声明了多个端口的类型：照样只有左右各一个不带 id 的连接点（端口不画成多个 Handle）", () => {
    setup(record("dc", "director"));
    wrapper = mount(NodeHost, {
      global: nodeKitGlobal(),
      props: nodeProps("dc", "director"),
    });

    const handles = wrapper.findAll('[data-stub="handle"]');
    expect(
      handles.map((item) => [
        item.attributes("data-handle-type"),
        item.attributes("data-handle-id"),
      ]),
    ).toEqual([
      ["target", ""],
      ["source", ""],
    ]);
  });

  it("文本只有输出：左边没有连接点，右边一个不带 id", () => {
    setup(record("txt", "text"));
    wrapper = mount(NodeHost, {
      global: nodeKitGlobal(),
      props: nodeProps("txt", "text"),
    });

    const handles = wrapper.findAll('[data-stub="handle"]');
    expect(
      handles.map((item) => [
        item.attributes("data-handle-type"),
        item.attributes("data-handle-id"),
      ]),
    ).toEqual([["source", ""]]);
  });

  it("图片 / 视频：generate 形态左右都有（有了图也一样）；成了素材（asset）左边收起（不再接受拖线），右边照旧", async () => {
    for (const type of ["image", "video"]) {
      const { store } = setup(record(`${type}1`, type));
      wrapper = mount(NodeHost, {
        global: nodeKitGlobal(),
        props: nodeProps(`${type}1`, type),
      });
      const sides = () =>
        wrapper!
          .findAll('[data-stub="handle"]')
          .map((item) => item.attributes("data-handle-type"));
      expect(sides(), type).toEqual(["target", "source"]);

      store.mutate((ctx) =>
        ops.writeNodeFields(ctx, `${type}1`, "data", {
          set: { src: "https://x/a" },
        }),
      );
      await nextTick();
      expect(sides(), type).toEqual(["target", "source"]);

      store.attachAsset(`${type}1`, { src: "https://x/a" });
      await nextTick();
      expect(sides(), type).toEqual(["source"]);
      wrapper.unmount();
      wrapper = null;
    }
  });

  it("连线只从出口往入口拉：左边不能起拉、点了没反应；右边不能当落点，点它弹出候选菜单（锚在这个连接点）", async () => {
    setup(record("img", "image"));
    wrapper = mount(NodeHost, {
      global: nodeKitGlobal(),
      props: nodeProps("img", "image"),
    });

    const target = wrapper.find('[data-handle-type="target"]');
    const source = wrapper.find('[data-handle-type="source"]');
    expect(target.attributes("data-connectable-start")).toBe("false");
    expect(source.attributes("data-connectable-end")).toBe("false");
    // 左边没有加号：不挂提示、点击不长节点
    expect(target.attributes("title")).toBeUndefined();
    await target.trigger("click");
    expect(openGrowMenu).not.toHaveBeenCalled();

    await source.trigger("click");
    expect(openGrowMenu).toHaveBeenCalledTimes(1);
    expect(openGrowMenu).toHaveBeenCalledWith("img", {
      anchor: source.element,
    });
    // 点加号不把原节点选中（要选中的是新长出来的那个）
    expect(selectOnly).not.toHaveBeenCalled();
  });

  it("入口平时不露（选中也不露）；从别的节点出口拉线、且这条线能接进来时才标成可落点", async () => {
    setup(record("img", "image"));
    selectedNodeId.value = "img";
    wrapper = mount(NodeHost, {
      global: nodeKitGlobal(),
      props: nodeProps("img", "image"),
    });
    const target = () => wrapper!.find('[data-handle-type="target"]');
    expect(target().classes()).not.toContain("flow-handle--droppable");

    connectionStartHandle.value = { nodeId: "other", type: "source", id: null };
    await nextTick();
    expect(target().classes()).toContain("flow-handle--droppable");
    expect(isValidConnection).toHaveBeenLastCalledWith(
      expect.objectContaining({ source: "other", target: "img" }),
    );

    // 连线规则不认可：不露
    isValidConnection.mockReturnValue(false);
    connectionStartHandle.value = {
      nodeId: "another",
      type: "source",
      id: null,
    };
    await nextTick();
    expect(target().classes()).not.toContain("flow-handle--droppable");

    // 从自己的出口拉出来的线：自己的入口不露
    isValidConnection.mockReturnValue(true);
    connectionStartHandle.value = { nodeId: "img", type: "source", id: null };
    await nextTick();
    expect(target().classes()).not.toContain("flow-handle--droppable");
  });

  it("出口带一条感应区；鼠标在里面移动后点击，菜单锚在加号此刻的位置而不是手柄元素", async () => {
    setup(record("img", "image"));
    wrapper = mount(NodeHost, {
      global: nodeKitGlobal(),
      props: nodeProps("img", "image"),
    });

    const source = wrapper.find('[data-handle-type="source"]');
    expect(source.find(".flow-handle-zone").exists()).toBe(true);
    expect(
      wrapper.find('[data-handle-type="target"] .flow-handle-zone').exists(),
    ).toBe(false);

    // jsdom 里手柄的盒子在 (0,0)，缩放 1：鼠标在 (30, 0) → 加号圆心就在那
    // jsdom 没有 PointerEvent；处理函数只读 clientX / clientY，用 MouseEvent 发同名事件
    source.element.dispatchEvent(
      new MouseEvent("pointermove", { clientX: 30, clientY: 0, bubbles: true }),
    );
    await nextTick();
    expect(
      (source.element as HTMLElement).style.getPropertyValue(
        "--flow-handle-follow-x",
      ),
    ).toBe("30px");

    await source.trigger("click");
    const place = openGrowMenu.mock.calls[0]?.[1] as {
      anchor: { getBoundingClientRect: () => DOMRect };
    };
    expect(place.anchor).not.toBe(source.element);
    const rect = place.anchor.getBoundingClientRect();
    expect(rect.left + rect.width / 2).toBe(30);

    // 离开后回到默认位置，再点就锚回手柄元素
    await source.trigger("pointerleave");
    expect(
      (source.element as HTMLElement).style.getPropertyValue(
        "--flow-handle-follow-x",
      ),
    ).toBe("");
    await source.trigger("click");
    expect(openGrowMenu).toHaveBeenLastCalledWith("img", {
      anchor: source.element,
    });
  });

  it("分组不画连接点（类型声明不启用 connectable），但外壳和拉伸手柄照常", () => {
    setup(record("g1", "group"));
    wrapper = mount(NodeHost, {
      global: nodeKitGlobal(),
      props: nodeProps("g1", "group"),
    });

    expect(wrapper.findAll('[data-stub="handle"]')).toHaveLength(0);
    expect(wrapper.find('[data-stub="resizer"]').exists()).toBe(true);
    // 名字照样由外壳画在框外
    expect(wrapper.text()).toContain("节点 g1");
  });

  it("文本可拉伸：只有右下角一个手柄，自由拉伸（不锁比例），最小宽 160", () => {
    setup(record("t1", "text"));
    wrapper = mount(NodeHost, {
      global: nodeKitGlobal(),
      props: nodeProps("t1", "text"),
    });

    const resizers = wrapper.findAll('[data-stub="resizer"]');
    expect(resizers).toHaveLength(1);
    expect(resizers[0]!.attributes("data-position")).toBe("bottom-right");
    // NodeResizeControl 不自己注入节点 id，没传就拖不动
    expect(resizers[0]!.attributes("data-node-id")).toBe("t1");
    expect(resizers[0]!.attributes("data-keep-ratio")).toBe("false");
    expect(resizers[0]!.attributes("data-min-width")).toBe("160");
  });

  it("图片 / 视频不可拉伸：没有拉伸手柄", () => {
    setup(record("i1", "image"));
    wrapper = mount(NodeHost, {
      global: nodeKitGlobal(),
      props: nodeProps("i1", "image"),
    });

    expect(wrapper.find('[data-stub="resizer"]').exists()).toBe(false);
  });

  it("双击名字改名：经 useFlowNode 写到 metadata.label，data 不受影响", async () => {
    const { store, doc } = setup(
      record("n1", "image", { data: { prompt: "一只猫" } }),
    );
    wrapper = mount(NodeHost, {
      global: nodeKitGlobal(),
      props: nodeProps("n1", "image"),
    });

    await wrapper.find('[data-node-title]').trigger("dblclick");
    // 改名不选中节点
    expect(selectOnly).not.toHaveBeenCalled();
    const input = wrapper.find("input");
    await input.setValue("  新名字  ");
    await input.trigger("keydown", { key: "Enter" });

    const node = store.nodeById.get("n1")!;
    expect(node.metadata.label).toBe("新名字");
    expect(node.data).toEqual({ prompt: "一只猫" });
    expect(nodeGroup(doc, "n1", "metadata")!.get("label")).toBe("新名字");
    expect(nodeGroup(doc, "n1", "data")!.has("label")).toBe(false);
  });

  it("改名改成空白不提交（误操作不是改名）", async () => {
    const { store } = setup(record("n1", "process"));
    wrapper = mount(NodeHost, {
      global: nodeKitGlobal(),
      props: nodeProps("n1", "process"),
    });

    await wrapper.find('[data-node-title]').trigger("dblclick");
    const input = wrapper.find("input");
    await input.setValue("   ");
    await input.trigger("blur");

    expect(store.nodeById.get("n1")!.metadata.label).toBe("节点 n1");
  });

  it("没起名的老节点显示兜底名（类型外观的 fallbackLabel）", () => {
    setup(record("n1", "process", { metadata: { label: "" } }));
    wrapper = mount(NodeHost, {
      global: nodeKitGlobal(),
      props: nodeProps("n1", "process"),
    });
    expect(wrapper.find('[data-node-title]').text()).toBe("流程节点");
  });

  it("分组：工具条最左是「布局」下拉，然后是「解组」；解组走画布的 deleteNode（组内节点由 store 解开）", async () => {
    setup(record("g1", "group"));
    selectedNodeId.value = "g1";
    deleteNode.mockClear();
    wrapper = mount(NodeHost, {
      global: nodeKitGlobal(),
      props: nodeProps("g1", "group"),
    });
    await nextTick();

    const buttons = wrapper.findAll('[data-node-slot="toolbar"] button');
    expect(buttons.map((item) => item.attributes("title"))).toEqual([
      "布局（重新排列组内节点）",
      "解组（拆掉分组框，组内节点保留）（Mod+Shift+G）",
    ]);
    await buttons[1]?.trigger("click");
    expect(deleteNode).toHaveBeenCalledWith("g1");
  });

  it("文本：双击节点本体进入编辑，失焦提交到 data.text；双击不再冒泡到画布", async () => {
    const { store } = setup(record("t1", "text"));
    const outer = vi.fn();
    wrapper = mount(
      defineComponent({
        setup: () => () =>
          h("div", { onDblclick: outer }, [
            h(NodeHost, nodeProps("t1", "text")),
          ]),
      }),
      { global: nodeKitGlobal() },
    );

    await wrapper.find('[data-testid="text-body"]').trigger("dblclick");
    expect(selectOnly).toHaveBeenCalledWith("t1");
    expect(outer).not.toHaveBeenCalled();
    const textarea = wrapper.find("textarea");
    await textarea.setValue("第一行\n第二行");
    await textarea.trigger("blur");

    expect(store.nodeById.get("t1")!.data.text).toBe("第一行\n第二行");
    expect(wrapper.find("textarea").exists()).toBe(false);
  });

  it("文本：Esc 取消编辑，不写文档", async () => {
    const { store } = setup(record("t1", "text", { data: { text: "原文" } }));
    wrapper = mount(NodeHost, {
      global: nodeKitGlobal(),
      props: nodeProps("t1", "text"),
    });

    await wrapper.find('[data-testid="text-body"]').trigger("dblclick");
    await wrapper.find("textarea").setValue("改了");
    await wrapper.find("textarea").trigger("keydown", { key: "Escape" });

    expect(store.nodeById.get("t1")!.data.text).toBe("原文");
    expect(wrapper.find("textarea").exists()).toBe(false);
  });
});

describe("各类型的 body", () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
  });

  it("文本：占满节点、无边框的正文区，有正文显示正文", () => {
    setup(record("t1", "text", { data: { text: "第一行\n第二行" } }));
    wrapper = mount(NodeHost, {
      global: nodeKitGlobal(),
      props: nodeProps("t1", "text"),
    });
    const body = wrapper.find('[data-testid="text-body"]');
    expect(body.classes()).not.toContain("border");
    expect(body.text()).toBe("第一行\n第二行");
  });

  it("图片：有 data.src 就画那张图；没有是空占位，右上角（角标区）一枚上传图标，有了图就收起", async () => {
    const { store } = setup(record("img", "image"));
    wrapper = mount(NodeHost, {
      global: nodeKitGlobal(),
      props: nodeProps("img", "image"),
    });
    const empty = wrapper.find('[data-testid="image-body-empty"]');
    expect(empty.text()).toContain("暂无图片");
    // 上传入口不在占位中间，在角标区
    expect(empty.find('[data-testid="node-upload-button"]').exists()).toBe(
      false,
    );
    const button = wrapper.find('[data-testid="node-upload-button"]');
    expect(button.attributes("aria-label")).toBe("上传图片");
    expect(button.text()).toBe("");
    // 在角标区里：右上角，整块按屏幕尺寸画、不随缩放变
    expect(button.element.parentElement?.getAttribute("data-node-slot")).toBe("badge");
    expect(button.element.parentElement?.classList).toContain("flow-screen-fixed");
    expect(
      wrapper.find('[data-testid="node-upload-input"]').attributes("accept"),
    ).toBe("image/*");
    expect(wrapper.find('[data-testid="image-body"] img').exists()).toBe(false);

    store.attachAsset("img", { src: "https://x/a.png" });
    await nextTick();
    expect(
      wrapper.find('[data-testid="image-body"] img').attributes("src"),
    ).toBe("https://x/a.png");
    expect(wrapper.find('[data-testid="image-body-empty"]').exists()).toBe(
      false,
    );
    expect(wrapper.find('[data-testid="node-upload-button"]').exists()).toBe(
      false,
    );
  });

  it("图片是本服务素材：先垫毛玻璃的图标档，图标到了才请求低清档，低清档加载完盖上去；缩得很小只用图标档、不要占位", async () => {
    zoomLevel.value = 1;
    const id = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    const src = `https://s3.test/b/canvas/assets/3f/a8/${id}.png`;
    setup(record("img", "image", { data: { src } }));
    wrapper = mount(NodeHost, {
      global: nodeKitGlobal(),
      props: nodeProps("img", "image"),
    });
    const body = () => wrapper!.find('[data-testid="image-body"]');

    const placeholder = body().find('[data-role="placeholder"]');
    expect(placeholder.attributes("src")).toBe(
      src.replace(".png", "@icon.webp"),
    );
    expect(placeholder.classes()).toContain("blur-md");
    // 图标还在路上：低清档先不发请求
    expect(body().find('[data-role="main"]').exists()).toBe(false);

    await placeholder.trigger("load");
    const main = body().find('[data-role="main"]');
    expect(main.attributes("src")).toBe(src.replace(".png", "@low.webp"));
    expect(main.classes()).toContain("opacity-0");

    await main.trigger("load");
    expect(body().find('[data-role="placeholder"]').exists()).toBe(false);
    expect(body().find('[data-role="main"]').classes()).not.toContain(
      "opacity-0",
    );

    // 320px 宽的节点缩到 0.1：屏幕上 32 物理像素，图标档够用
    zoomLevel.value = 0.1;
    await nextTick();
    expect(body().find('[data-role="main"]').attributes("src")).toBe(
      src.replace(".png", "@icon.webp"),
    );
    expect(body().find('[data-role="placeholder"]').exists()).toBe(false);

    // 再放大：换回低清，加载期间露出毛玻璃占位；图标早有结果，低清档不再等它
    zoomLevel.value = 1;
    await nextTick();
    expect(body().find('[data-role="main"]').attributes("src")).toBe(
      src.replace(".png", "@low.webp"),
    );
    expect(body().find('[data-role="placeholder"]').exists()).toBe(true);
  });

  it("换了图：重新先等新图的图标档", async () => {
    zoomLevel.value = 1;
    const id = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    const src = `https://s3.test/b/canvas/assets/3f/a8/${id}.png`;
    const { store } = setup(record("img", "image", { data: { src } }));
    wrapper = mount(NodeHost, {
      global: nodeKitGlobal(),
      props: nodeProps("img", "image"),
    });
    const body = () => wrapper!.find('[data-testid="image-body"]');

    await body().find('[data-role="placeholder"]').trigger("load");
    expect(body().find('[data-role="main"]').exists()).toBe(true);

    store.attachAsset("img", { src: src.replace("3fa85f64", "3fa8aaaa") });
    await nextTick();
    expect(body().find('[data-role="main"]').exists()).toBe(false);
  });

  it("外部链接没有图标档：不等，直接加载", () => {
    zoomLevel.value = 1;
    setup(
      record("img", "image", { data: { src: "https://example.com/a.png" } }),
    );
    wrapper = mount(NodeHost, {
      global: nodeKitGlobal(),
      props: nodeProps("img", "image"),
    });
    const body = wrapper.find('[data-testid="image-body"]');
    expect(body.find('[data-role="placeholder"]').exists()).toBe(false);
    expect(body.find('[data-role="main"]').attributes("src")).toBe(
      "https://example.com/a.png",
    );
  });

  it("没有缩略图（图标档 404）：撤掉占位，目标档照常显示；低清档也 404 就退回原图", async () => {
    zoomLevel.value = 1;
    const id = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    const src = `https://s3.test/b/canvas/assets/3f/a8/${id}.png`;
    setup(record("img", "image", { data: { src } }));
    wrapper = mount(NodeHost, {
      global: nodeKitGlobal(),
      props: nodeProps("img", "image"),
    });
    const body = () => wrapper!.find('[data-testid="image-body"]');

    await body().find('[data-role="placeholder"]').trigger("error");
    expect(body().find('[data-role="placeholder"]').exists()).toBe(false);
    expect(body().find('[data-role="main"]').classes()).not.toContain(
      "opacity-0",
    );

    await body().find('[data-role="main"]').trigger("error");
    expect(body().find('[data-role="main"]').attributes("src")).toBe(src);
  });

  it("视频：平时只画预览图 data.poster，不放 <video>；没有预览图是空占位", async () => {
    const { store } = setup(record("vid", "video"));
    wrapper = mount(NodeHost, {
      global: nodeKitGlobal(),
      props: nodeProps("vid", "video"),
    });
    expect(wrapper.find('[data-testid="video-body-empty"]').text()).toContain(
      "暂无视频",
    );
    expect(
      wrapper
        .find('[data-testid="node-upload-button"]')
        .attributes("aria-label"),
    ).toBe("上传视频");
    expect(
      wrapper.find('[data-testid="node-upload-input"]').attributes("accept"),
    ).toBe("video/*");

    store.attachAsset("vid", { src: "https://x/a.mp4" });
    await nextTick();
    expect(wrapper.find('[data-testid="video-body-empty"]').text()).toBe(
      "暂无预览图",
    );
    // 已经有视频了，不再给上传入口
    expect(wrapper.find('[data-testid="node-upload-button"]').exists()).toBe(
      false,
    );

    store.attachAsset("vid", {
      src: "https://x/a.mp4",
      poster: "https://x/p.png",
    });
    await nextTick();
    expect(
      wrapper.find('[data-testid="video-body"] img').attributes("src"),
    ).toBe("https://x/p.png");
    expect(wrapper.find("video").exists()).toBe(false);
  });

  it("视频：鼠标移上来挂 <video> 盖满播放区静音循环播放，移出就卸掉换回预览图", async () => {
    setup(
      record("vid", "video", {
        data: { src: "https://x/v.mp4", poster: "https://x/p.jpg" },
      }),
    );
    wrapper = mount(NodeHost, {
      global: nodeKitGlobal(),
      props: nodeProps("vid", "video"),
    });
    const body = wrapper.find('[data-testid="video-body"]');

    await body.trigger("mouseenter");
    const video = body.find('[data-testid="hover-video"]');
    expect(video.attributes("src")).toBe("https://x/v.mp4");
    expect(video.classes()).toEqual(
      expect.arrayContaining([
        "absolute",
        "inset-0",
        "h-full",
        "w-full",
        "object-cover",
      ]),
    );
    expect((video.element as HTMLVideoElement).muted).toBe(true);
    expect(video.attributes()).toHaveProperty("loop");
    // 预览图还在下面垫着，尺寸不跟着变
    expect(body.find("img").attributes("src")).toBe("https://x/p.jpg");

    await body.trigger("mouseleave");
    expect(wrapper.find("video").exists()).toBe(false);
  });

  it("视频：悬停播放带控制栏 —— 播放 / 暂停、拖进度、开关声音；有声自动播放被拦就退回静音", async () => {
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockImplementation(function (this: HTMLMediaElement) {
        this.dispatchEvent(new Event("play"));
        return Promise.resolve();
      });
    const pause = vi
      .spyOn(HTMLMediaElement.prototype, "pause")
      .mockImplementation(function (this: HTMLMediaElement) {
        this.dispatchEvent(new Event("pause"));
      });
    try {
      setup(
        record("vid", "video", {
          data: { src: "https://x/v.mp4", poster: "https://x/p.jpg" },
        }),
      );
      wrapper = mount(NodeHost, {
        global: nodeKitGlobal(),
        props: nodeProps("vid", "video"),
      });
      const body = wrapper.find('[data-testid="video-body"]');
      expect(body.find('[data-testid="hover-video-controls"]').exists()).toBe(
        false,
      );

      await body.trigger("mouseenter");
      await nextTick();
      expect(play).toHaveBeenCalledTimes(1);
      const controls = body.find('[data-testid="hover-video-controls"]');
      // 控制栏按下去不该拖节点 / 拖画布
      expect(controls.classes()).toEqual(
        expect.arrayContaining(["nodrag", "nopan"]),
      );
      expect(
        controls
          .find('[data-testid="hover-video-play"]')
          .attributes("aria-label"),
      ).toBe("暂停");

      await controls.find('[data-testid="hover-video-play"]').trigger("click");
      expect(pause).toHaveBeenCalledTimes(1);
      expect(
        controls
          .find('[data-testid="hover-video-play"]')
          .attributes("aria-label"),
      ).toBe("播放");

      const video = body.find("video").element as HTMLVideoElement;
      Object.defineProperty(video, "duration", {
        configurable: true,
        value: 75,
      });
      await body.find("video").trigger("loadedmetadata");
      expect(controls.find('[data-testid="hover-video-time"]').text()).toBe(
        "0:00 / 1:15",
      );

      await controls.find('[data-testid="hover-video-mute"]').trigger("click");
      expect(video.muted).toBe(false);
      expect(
        controls
          .find('[data-testid="hover-video-mute"]')
          .attributes("aria-label"),
      ).toBe("静音");

      // 再移上来：接着有声音；浏览器拦下有声自动播放 → 退回静音再播
      await body.trigger("mouseleave");
      play.mockImplementationOnce(() =>
        Promise.reject(new DOMException("blocked", "NotAllowedError")),
      );
      await body.trigger("mouseenter");
      await nextTick();
      await flushPromises();
      expect(play).toHaveBeenCalledTimes(3);
      expect((body.find("video").element as HTMLVideoElement).muted).toBe(true);
      expect(
        body.find('[data-testid="hover-video-mute"]').attributes("aria-label"),
      ).toBe("打开声音");
    } finally {
      play.mockRestore();
      pause.mockRestore();
    }
  });

  it("视频：拖动节点时暂停，松手接着播；拖之前就停着的松手也不播", async () => {
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockImplementation(function (this: HTMLMediaElement) {
        this.dispatchEvent(new Event("play"));
        return Promise.resolve();
      });
    const pause = vi
      .spyOn(HTMLMediaElement.prototype, "pause")
      .mockImplementation(function (this: HTMLMediaElement) {
        this.dispatchEvent(new Event("pause"));
      });
    try {
      setup(
        record("vid", "video", {
          data: { src: "https://x/v.mp4", poster: "https://x/p.jpg" },
        }),
      );
      wrapper = mount(NodeHost, {
        global: nodeKitGlobal(),
        props: nodeProps("vid", "video"),
      });
      const body = wrapper.find('[data-testid="video-body"]');
      await body.trigger("mouseenter");
      await nextTick();
      expect(play).toHaveBeenCalledTimes(1);

      await wrapper.setProps({ dragging: true });
      expect(pause).toHaveBeenCalledTimes(1);
      await wrapper.setProps({ dragging: false });
      expect(play).toHaveBeenCalledTimes(2);

      // 用户先点了暂停，再拖：松手不该自己播起来
      await body.find('[data-testid="hover-video-play"]').trigger("click");
      expect(pause).toHaveBeenCalledTimes(2);
      await wrapper.setProps({ dragging: true });
      await wrapper.setProps({ dragging: false });
      expect(play).toHaveBeenCalledTimes(2);
    } finally {
      play.mockRestore();
      pause.mockRestore();
    }
  });

  it("视频：没有视频地址时移上来不播放；视频加载失败就收起", async () => {
    const { store } = setup(record("vid", "video"));
    wrapper = mount(NodeHost, {
      global: nodeKitGlobal(),
      props: nodeProps("vid", "video"),
    });
    const body = wrapper.find('[data-testid="video-body"]');
    await body.trigger("mouseenter");
    expect(wrapper.find("video").exists()).toBe(false);

    store.attachAsset("vid", { src: "https://x/v.mp4" });
    await nextTick();
    await body.trigger("mouseleave");
    await body.trigger("mouseenter");
    await body.find("video").trigger("error");
    expect(wrapper.find("video").exists()).toBe(false);
  });

  it("图片 / 视频预览图加载完：按高宽比记进布局（竖图定宽、横图定高），节点按布局尺寸画", async () => {
    const { store } = setup(
      record("img", "image", { data: { src: "https://x/tall.png" } }),
    );
    wrapper = mount(NodeHost, {
      global: nodeKitGlobal(),
      props: nodeProps("img", "image"),
    });
    // 还没量过：默认宽度、高度随图片
    expect(wrapper.attributes("style")).toBe("width: 320px;");
    expect(
      wrapper.find('[data-testid="image-body"]').attributes("style"),
    ).toBeUndefined();

    const img = wrapper.find('[data-testid="image-body"] img');
    Object.defineProperty(img.element, "naturalWidth", { value: 600 });
    Object.defineProperty(img.element, "naturalHeight", { value: 900 });
    await img.trigger("load");
    expect(store.nodeById.get("img")?.layout).toMatchObject({
      width: 240,
      height: 360,
    });
    expect(wrapper.attributes("style")).toBe("width: 240px;");
    expect(wrapper.find('[data-testid="image-body"]').attributes("style")).toBe(
      "aspect-ratio: 240 / 360;",
    );

    store.addNode(
      record("vid", "video", {
        data: { src: "https://x/v.mp4", poster: "https://x/p.jpg" },
      }),
    );
    const video = mount(NodeHost, {
      global: nodeKitGlobal(),
      props: nodeProps("vid", "video"),
    });
    const poster = video.find('[data-testid="video-body"] img');
    Object.defineProperty(poster.element, "naturalWidth", { value: 1920 });
    Object.defineProperty(poster.element, "naturalHeight", { value: 1080 });
    await poster.trigger("load");
    expect(store.nodeById.get("vid")?.layout).toMatchObject({
      width: 427,
      height: 240,
    });
    video.unmount();
  });

  it("布局里已经记过尺寸：一打开就按它画，不等资源加载", () => {
    setup(
      record("img", "image", {
        layout: { position: { x: 0, y: 0 }, width: 427, height: 240 },
      }),
    );
    wrapper = mount(NodeHost, {
      global: nodeKitGlobal(),
      props: nodeProps("img", "image"),
    });
    expect(wrapper.attributes("style")).toBe("width: 427px;");
    expect(wrapper.find('[data-testid="image-body"]').attributes("style")).toBe(
      "aspect-ratio: 427 / 240;",
    );
  });

  it("报错不影响图片：报错行接在图片区后面，图片区照旧按记录的比例", () => {
    setup(
      record("img", "image", {
        layout: { position: { x: 0, y: 0 }, width: 240, height: 427 },
        data: { src: "https://x/a.png" },
        runtime: { status: "error", error: "生成失败" },
      }),
    );
    wrapper = mount(NodeHost, {
      global: nodeKitGlobal(),
      props: nodeProps("img", "image"),
    });
    const body = wrapper.find('[data-testid="image-body"]');
    expect(body.attributes("style")).toBe("aspect-ratio: 240 / 427;");
    expect(body.element.nextElementSibling?.getAttribute("data-testid")).toBe(
      "node-status-error",
    );
    // 根元素不钉高度，报错行是多出来的一截
    expect(wrapper.attributes("style")).toBe("width: 240px;");
  });

  it("图片上传：选了文件 → 传到本画布 → S3 原始地址写进 data.src", async () => {
    uploadAsset
      .mockReset()
      .mockResolvedValue({ url: "https://s3.test/b/flows/flow-1/a.png" });
    const { store } = setup(record("img", "image"));
    wrapper = mount(NodeHost, {
      global: nodeKitGlobal(),
      props: nodeProps("img", "image"),
    });

    const file = new File(["x"], "a.png", { type: "image/png" });
    const input = wrapper.find('[data-testid="node-upload-input"]');
    Object.defineProperty(input.element, "files", {
      value: [file],
      configurable: true,
    });
    await input.trigger("change");
    await vi.waitFor(() =>
      expect(store.nodeById.get("img")?.data.src).toBe(
        "https://s3.test/b/flows/flow-1/a.png",
      ),
    );
    expect(uploadAsset).toHaveBeenCalledWith(
      "flow-1",
      file,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    // 没有连入的线：上传之后就是素材（attachAsset 同一步定的形态）
    expect(store.nodeById.get("img")?.data.form).toBe("asset");
  });

  it("视频上传：本地截一帧当预览图，视频和预览图一起传，一次写进 src / poster", async () => {
    const frame = new Blob(["jpg"], { type: "image/jpeg" });
    captureVideoPoster.mockReset().mockResolvedValue(frame);
    uploadAsset
      .mockReset()
      .mockImplementation(async (_flowId: string, file: Blob) => ({
        url:
          file === frame
            ? "https://s3.test/b/p.jpg"
            : "https://s3.test/b/v.mp4",
      }));
    const { store } = setup(record("vid", "video"));
    wrapper = mount(NodeHost, {
      global: nodeKitGlobal(),
      props: nodeProps("vid", "video"),
    });

    const file = new File(["x"], "v.mp4", { type: "video/mp4" });
    const input = wrapper.find('[data-testid="node-upload-input"]');
    Object.defineProperty(input.element, "files", {
      value: [file],
      configurable: true,
    });
    await input.trigger("change");
    await vi.waitFor(() =>
      expect(store.nodeById.get("vid")?.data).toMatchObject({
        src: "https://s3.test/b/v.mp4",
        poster: "https://s3.test/b/p.jpg",
        form: "asset",
      }),
    );
    expect(uploadAsset).toHaveBeenCalledWith(
      "flow-1",
      frame,
      expect.objectContaining({
        filename: "poster.jpg",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("上传中：占位换成进度（不显示「暂无」和上传按钮），挂「上传中」角标；分片有百分比", async () => {
    let report: (loaded: number, total: number) => void = () => undefined;
    let finish: (value: { url: string }) => void = () => undefined;
    uploadAsset.mockReset().mockImplementation(
      (_flowId: string, _file: Blob, io: { onProgress: typeof report }) =>
        new Promise((resolve) => {
          report = io.onProgress;
          finish = resolve;
        }),
    );
    const { store } = setup(record("img", "image"));
    wrapper = mount(NodeHost, {
      global: nodeKitGlobal(),
      props: nodeProps("img", "image"),
    });

    const input = wrapper.find('[data-testid="node-upload-input"]');
    Object.defineProperty(input.element, "files", {
      value: [new File(["x"], "a.png")],
      configurable: true,
    });
    await input.trigger("change");
    await nextTick();

    // 还没有进度（一次传完的就一直这样）：只转圈
    expect(wrapper.find('[data-testid="node-upload-progress"]').exists()).toBe(
      true,
    );
    expect(wrapper.find('[data-testid="node-upload-percent"]').exists()).toBe(
      false,
    );
    expect(wrapper.find('[data-testid="node-upload-button"]').exists()).toBe(
      false,
    );
    expect(wrapper.text()).not.toContain("暂无图片");
    expect(wrapper.find('[data-testid="node-status-uploading"]').exists()).toBe(
      true,
    );

    report(30, 120);
    await nextTick();
    expect(wrapper.find('[data-testid="node-upload-percent"]').text()).toBe(
      "上传中 25%",
    );

    finish({ url: "https://s3.test/b/a.png" });
    await vi.waitFor(() =>
      expect(store.nodeById.get("img")?.data.src).toBe(
        "https://s3.test/b/a.png",
      ),
    );
    await nextTick();
    expect(wrapper.find('[data-testid="node-status-uploading"]').exists()).toBe(
      false,
    );
  });

  it("取消上传：断开请求、什么都不写，占位回到「暂无 + 上传」", async () => {
    let signal: AbortSignal | undefined;
    uploadAsset.mockReset().mockImplementation(
      (_flowId: string, _file: Blob, io: { signal: AbortSignal }) =>
        new Promise((_, reject) => {
          signal = io.signal;
          io.signal.addEventListener("abort", () => reject(io.signal.reason));
        }),
    );
    const { store } = setup(record("img", "image"));
    const mounted = mount(NodeHost, {
      global: nodeKitGlobal(),
      props: nodeProps("img", "image"),
    });
    wrapper = mounted;

    const input = mounted.find('[data-testid="node-upload-input"]');
    Object.defineProperty(input.element, "files", {
      value: [new File(["x"], "a.png")],
      configurable: true,
    });
    await input.trigger("change");
    await nextTick();
    await mounted.find('[data-testid="node-upload-cancel"]').trigger("click");

    expect(signal?.aborted).toBe(true);
    await vi.waitFor(() =>
      expect(mounted.find('[data-testid="node-upload-button"]').exists()).toBe(
        true,
      ),
    );
    expect(mounted.find('[data-testid="node-upload-progress"]').exists()).toBe(
      false,
    );
    expect(store.nodeById.get("img")?.data.src ?? "").toBe("");
  });

  it("导演台：右上角（角标区）的「打开导演台」图标发出 director:open（发出方是这个节点），不写文档；body 中间一枚图标", async () => {
    const { store } = setup(record("dc", "director"));
    const runtime = createNodeKitRuntime(createDefaultNodeKit());
    const global = { provide: { [NODE_KIT_KEY as symbol]: runtime } };
    const opened: string[] = [];
    runtime.kit.on("director:open", (_, ctx) => opened.push(ctx.id));
    wrapper = mount(NodeHost, { global, props: nodeProps("dc", "director") });
    const button = wrapper.find('[data-testid="director-open"]');
    expect(button.element.tagName).toBe("BUTTON");
    expect(button.attributes("aria-label")).toBe("打开导演台");
    expect(button.text()).toBe("");
    // 和上传按钮同一个位置、同一套屏幕尺寸规则
    expect(button.element.parentElement?.getAttribute("data-node-slot")).toBe("badge");
    expect(wrapper.find('[data-testid="director-body"] [data-testid="director-icon"]').exists()).toBe(true);

    const before = JSON.stringify(store.nodeById.get("dc"));
    await button.trigger("click");
    expect(opened).toEqual(["dc"]);
    expect(JSON.stringify(store.nodeById.get("dc"))).toBe(before);
  });
});
