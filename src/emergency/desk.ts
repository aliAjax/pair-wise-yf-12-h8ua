// 应急保供核销台 —— 状态层
// 组合规则层与存储层，持有单据与库存的运行时状态；页面只调用这里的动作，不直接改数。

import { computed, reactive } from "vue";
import {
  DEVIATION_LIMIT,
  availableQuota,
  exceedsDeviation,
  isUnfinished,
  validateComplete,
  validateRegister,
  validateReview
} from "./rules";
import type {
  FuelType,
  RegisterInput,
  Snapshot,
  SupplyOrder,
  Truck
} from "./rules";
import {
  SEED_STATIONS,
  SEED_TRUCKS,
  loadSnapshot,
  resetSnapshot,
  saveSnapshot
} from "./storage";

export interface ActionResult {
  ok: boolean;
  errors?: string[];
  /** 完成提货是否转入待复核 */
  review?: boolean;
}

const snapshot: Snapshot = reactive(loadSnapshot()) as Snapshot;

const trucks: readonly Truck[] = SEED_TRUCKS;
const stations = SEED_STATIONS;

function persist() {
  saveSnapshot({ orders: snapshot.orders, stationStock: snapshot.stationStock });
}

function patchOrder(id: string, patch: Partial<SupplyOrder>) {
  const index = snapshot.orders.findIndex((order) => order.id === id);
  if (index === -1) return;
  snapshot.orders[index] = {
    ...snapshot.orders[index],
    ...patch,
    updatedAt: new Date().toISOString()
  };
}

/** 登记：校验不通过整单拒绝，任何原有数值不动 */
function register(input: RegisterInput): ActionResult {
  const truck = trucks.find((item) => item.plate === input.plate);
  const result = validateRegister(
    { ...input, declaredLiters: Number(input.declaredLiters) },
    {
      trucks,
      stations,
      stockByStation: snapshot.stationStock,
      orders: snapshot.orders
    }
  );
  if (result.length > 0 || !truck) return { ok: false, errors: result };

  const station = stations.find((item) => item.station === input.station)!;
  const now = new Date().toISOString();
  const order: SupplyOrder = {
    id: crypto.randomUUID(),
    plate: truck.plate,
    station: station.station,
    area: station.area,
    fuelType: station.fuelType as FuelType,
    declaredLiters: Number(input.declaredLiters),
    actualLiters: null,
    status: "待处理",
    reviewReason: "",
    note: input.note.trim(),
    createdAt: now,
    updatedAt: now
  };
  snapshot.orders.unshift(order);
  persist();
  return { ok: true };
}

/** 取消未完成单：不补库存（库存从未扣减），额度随状态解冻 */
function cancel(id: string): ActionResult {
  const order = snapshot.orders.find((item) => item.id === id);
  if (!order) return { ok: false, errors: ["单据不存在"] };
  if (!isUnfinished(order.status)) return { ok: false, errors: ["仅未完成单据可以取消"] };
  patchOrder(id, { status: "已取消" });
  persist();
  return { ok: true };
}

/** 办结扣减：库存减实提量，额度随已完成状态释放 */
function finalize(order: SupplyOrder, actualLiters: number, reviewReason: string) {
  snapshot.stationStock[order.station] =
    (snapshot.stationStock[order.station] ?? 0) - actualLiters;
  patchOrder(order.id, {
    status: "已完成",
    actualLiters,
    reviewReason
  });
  persist();
}

/** 完成提货登记：偏差超两成转待复核（库存额度均不动），否则当场办结 */
function complete(id: string, rawActual: number): ActionResult {
  const order = snapshot.orders.find((item) => item.id === id);
  if (!order) return { ok: false, errors: ["单据不存在"] };
  if (order.status !== "待处理") return { ok: false, errors: ["仅待处理单据可以完成提货"] };

  const actualLiters = Number(rawActual);
  const errors = validateComplete(actualLiters);

  const station = stations.find((item) => item.station === order.station);
  const stockAfter = (snapshot.stationStock[order.station] ?? 0) - (actualLiters > 0 ? actualLiters : 0);
  if (actualLiters > 0 && station && stockAfter < station.floorStock) {
    errors.push(`提货后库存 ${stockAfter}L 低于保底库存 ${station.floorStock}L，请核减实提量`);
  }
  if (errors.length > 0) return { ok: false, errors };

  if (exceedsDeviation(order.declaredLiters, actualLiters)) {
    patchOrder(id, { status: "待复核", actualLiters });
    persist();
    return { ok: true, review: true };
  }

  finalize(order, actualLiters, "");
  return { ok: true };
}

/** 待复核确认：补写原因后才减库存和释放额度 */
function confirmReview(id: string, reason: string): ActionResult {
  const order = snapshot.orders.find((item) => item.id === id);
  if (!order) return { ok: false, errors: ["单据不存在"] };
  if (order.status !== "待复核") return { ok: false, errors: ["仅待复核单据可以确认"] };

  const errors = validateReview(reason);
  if (order.actualLiters == null) errors.push("缺少实提量记录");

  const station = stations.find((item) => item.station === order.station);
  const stockAfter =
    (snapshot.stationStock[order.station] ?? 0) - (order.actualLiters ?? 0);
  if (order.actualLiters != null && station && stockAfter < station.floorStock) {
    errors.push(`提货后库存 ${stockAfter}L 低于保底库存 ${station.floorStock}L`);
  }
  if (errors.length > 0) return { ok: false, errors };

  finalize(order, order.actualLiters!, reason.trim());
  return { ok: true };
}

function resetAll(): ActionResult {
  const fresh = resetSnapshot();
  snapshot.orders.splice(0, snapshot.orders.length, ...fresh.orders);
  Object.keys(snapshot.stationStock).forEach((key) => delete snapshot.stationStock[key]);
  Object.assign(snapshot.stationStock, fresh.stationStock);
  return { ok: true };
}

const truckSummaries = computed(() =>
  trucks.map((truck) => {
    const available = availableQuota(truck, snapshot.orders);
    return {
      ...truck,
      occupied: truck.quota - available,
      available
    };
  })
);

export function useEmergencyDesk() {
  return {
    DEVIATION_LIMIT,
    trucks,
    truckSummaries,
    stations,
    orders: computed(() => snapshot.orders),
    stationStock: computed(() => snapshot.stationStock),
    register,
    cancel,
    complete,
    confirmReview,
    resetAll
  };
}
