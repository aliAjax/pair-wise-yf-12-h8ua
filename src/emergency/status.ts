// 应急保供核销台 · 状态层
// 负责单据状态机、额度占用/核销核算、站点库存联动，
// 以及在每次流转后落盘；响应式状态在此集中持有。
import { computed, ref } from "vue";
import {
  VEHICLES,
  evaluateRegister,
  needsReview,
  type OrderStatus,
  type SupplyOrder,
  type SupplyStation,
  type SupplyVehicle
} from "./rules";
import { loadOrders, saveOrders } from "./storage";

export interface QuotaView {
  vehicle: SupplyVehicle;
  /** 未完成单按申报量冻结的额度 */
  frozen: number;
  /** 已完成单按实提量核销的额度 */
  used: number;
  available: number;
  openCount: number;
}

/** 状态中文标签集中维护，视图层只认这里 */
export const STATUS_META: Record<OrderStatus, { label: string; kind: string }> = {
  active: { label: "待提油", kind: "status" },
  reviewing: { label: "待复核", kind: "status status-review" },
  done: { label: "已完成", kind: "status status-done" },
  cancelled: { label: "已取消", kind: "status status-cancel" }
};

/** 未完成单：额度占用中，车辆不可再挂新单 */
export function isOpenStatus(status: OrderStatus): boolean {
  return status === "active" || status === "reviewing";
}

/** App 侧油站记录的最小结构（库存等字段可能是字符串） */
type StationRecord = {
  id: string;
  station?: unknown;
  area?: unknown;
  fuel?: unknown;
  stock?: unknown;
  floorStock?: unknown;
};

// 由 App.vue 注入油站记录读取函数与库存扣减函数；应急台本身不拥有油站数据
let readStationRecords: () => StationRecord[] = () => [];
let applyStockDeduction: (stationId: string, liters: number) => void = () => {};

export function bindStationRecords(
  reader: () => StationRecord[],
  deduction: (stationId: string, liters: number) => void
): void {
  readStationRecords = reader;
  applyStockDeduction = deduction;
}

function toStation(record: StationRecord): SupplyStation {
  return {
    id: String(record.id),
    station: String(record.station ?? ""),
    area: String(record.area ?? ""),
    fuel: String(record.fuel ?? ""),
    stock: Number(record.stock ?? 0) || 0,
    floorStock: Number(record.floorStock ?? 0) || 0
  };
}

export function stationView(): SupplyStation[] {
  return readStationRecords().map(toStation);
}

const orders = ref<SupplyOrder[]>(loadOrders());

function persist() {
  saveOrders(orders.value);
}

function findStation(stationId: string): SupplyStation | undefined {
  return stationView().find((station) => station.id === stationId);
}

function findVehicle(plate: string): SupplyVehicle | undefined {
  return VEHICLES.find((vehicle) => vehicle.plate === plate);
}

export function statusLabel(status: OrderStatus): string {
  return STATUS_META[status].label;
}

export function allOrders() {
  return orders;
}

export const openOrders = computed(() =>
  orders.value.filter((order) => isOpenStatus(order.status))
);

/** 各保供车的额度视图：冻结 = 未完成单申报额；已核销 = 已完成单实提额 */
export function vehicleQuotas(): QuotaView[] {
  return VEHICLES.map((vehicle) => {
    const mine = orders.value.filter((order) => order.plate === vehicle.plate);
    const frozen = mine
      .filter((order) => isOpenStatus(order.status))
      .reduce((sum, order) => sum + order.declared, 0);
    const used = mine
      .filter((order) => order.status === "done")
      .reduce((sum, order) => sum + (order.actual ?? order.declared), 0);
    return {
      vehicle,
      frozen,
      used,
      available: vehicle.quota - frozen - used,
      openCount: mine.filter((order) => isOpenStatus(order.status)).length
    };
  });
}

function quotaFor(plate: string): QuotaView {
  return vehicleQuotas().find((view) => view.vehicle.plate === plate)!;
}

export type ActionResult = { ok: boolean; message: string };

/**
 * 登记核销单：整单校验通过才建单，并按申报量冻结额度。
 * 任一规则不满足则整单拒绝，已有数值一律不动。
 */
export function registerOrder(input: {
  plate: string;
  stationId: string;
  declared: number;
}): ActionResult {
  const vehicle = findVehicle(input.plate);
  const station = findStation(input.stationId);
  const plateOpen = orders.value.filter(
    (order) => order.plate === input.plate && isOpenStatus(order.status)
  );
  const available = vehicle ? quotaFor(vehicle.plate).available : 0;

  const result = evaluateRegister(input, {
    vehicle,
    station,
    openOrders: plateOpen,
    availableQuota: available
  });
  if (!result.ok) return { ok: false, message: result.reason };

  const order: SupplyOrder = {
    id: crypto.randomUUID(),
    plate: input.plate,
    stationId: station!.id,
    stationName: station!.station,
    fuel: vehicle!.fuel,
    area: vehicle!.area,
    declared: input.declared,
    actual: null,
    status: "active",
    reviewReason: "",
    createdAt: new Date().toISOString(),
    finishedAt: null
  };
  orders.value = [order, ...orders.value];
  persist();
  return {
    ok: true,
    message: `已登记 ${input.plate} 申报 ${input.declared}L，额度冻结，等待提油核销`
  };
}

/** 取消未完成单：解冻额度，库存未提不动 */
export function cancelOrder(orderId: string): ActionResult {
  const order = orders.value.find((item) => item.id === orderId);
  if (!order) return { ok: false, message: "单据不存在" };
  if (!isOpenStatus(order.status)) {
    return { ok: false, message: "仅未完成单可取消" };
  }
  order.status = "cancelled";
  order.finishedAt = new Date().toISOString();
  persist();
  return { ok: true, message: `已取消，解冻 ${order.declared}L 申报额度` };
}

/**
 * 完成核销：填报实提量。
 * 偏差两成以内直接完成（扣库存、按实提核销额度）；
 * 超过两成转待复核，额度继续占用，不扣库存，等待补写原因后确认。
 */
export function submitActual(orderId: string, actual: number): ActionResult {
  const order = orders.value.find((item) => item.id === orderId);
  if (!order) return { ok: false, message: "单据不存在" };
  if (order.status !== "active") {
    return { ok: false, message: "仅待提油单可填报实提量" };
  }
  if (!Number.isFinite(actual) || actual < 0) {
    return { ok: false, message: "实提量必须是不小于 0 的升数" };
  }

  if (needsReview(order.declared, actual)) {
    order.actual = actual;
    order.status = "reviewing";
    persist();
    const ratio = (Math.abs(actual - order.declared) / order.declared) * 100;
    return {
      ok: true,
      message: `申报与实提相差 ${ratio.toFixed(1)}%，超过两成，已转待复核；额度继续占用，补写原因并确认后再扣库存和额度`
    };
  }

  return finalize(order, actual);
}

/** 待复核单补写差异原因并确认后，才真正扣库存、核销额度 */
export function confirmReview(orderId: string, reason: string): ActionResult {
  const order = orders.value.find((item) => item.id === orderId);
  if (!order) return { ok: false, message: "单据不存在" };
  if (order.status !== "reviewing") {
    return { ok: false, message: "仅待复核单需要复核确认" };
  }
  if (!reason.trim()) {
    return { ok: false, message: "请先补写差异原因再确认" };
  }
  if (order.actual === null) {
    return { ok: false, message: "缺少实提量，无法确认" };
  }
  order.reviewReason = reason.trim();
  return finalize(order, order.actual);
}

/** 终态收口：扣站点库存、按实提量核销冻结额度，单据置为已完成 */
function finalize(order: SupplyOrder, actual: number): ActionResult {
  const station = findStation(order.stationId);
  if (!station) return { ok: false, message: "提油站点已不存在，无法核销" };

  // 油站数据归 App 侧持有与持久化，经由绑定回调写回
  applyStockDeduction(station.id, actual);

  order.actual = actual;
  order.status = "done";
  order.finishedAt = new Date().toISOString();
  persist();
  return {
    ok: true,
    message: `核销完成：${station.station} 实提 ${actual}L，库存与额度已扣减`
  };
}
