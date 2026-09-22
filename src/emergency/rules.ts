// 应急保供核销台 · 业务规则层
// 只做纯校验与纯计算：不持有可变状态，不读写存储，不依赖 Vue。

export const FUEL_TYPES = ["92#汽油", "95#汽油", "0#柴油"] as const;
export type FuelType = (typeof FUEL_TYPES)[number];

export type OrderStatus = "active" | "reviewing" | "done" | "cancelled";

export interface SupplyVehicle {
  plate: string;
  fuel: FuelType;
  area: string;
  /** 总额度 L */
  quota: number;
}

export interface SupplyStation {
  id: string;
  station: string;
  area: string;
  fuel: string;
  /** 当前库存 L */
  stock: number;
  /** 保底库存 L */
  floorStock: number;
}

export interface SupplyOrder {
  id: string;
  plate: string;
  stationId: string;
  stationName: string;
  fuel: string;
  area: string;
  /** 申报量：登记时按此数冻结额度 */
  declared: number;
  /** 实提量：完成核销时填报 */
  actual: number | null;
  status: OrderStatus;
  /** 待复核单补写的差异原因 */
  reviewReason: string;
  createdAt: string;
  finishedAt: string | null;
}

/** 三辆应急保供车：各挂油品、准入区域和总额度 */
export const VEHICLES: readonly SupplyVehicle[] = [
  { plate: "沪A·5201应急", fuel: "92#汽油", area: "东区", quota: 20000 },
  { plate: "沪B·3308应急", fuel: "0#柴油", area: "西区", quota: 16000 },
  { plate: "沪A·7712应急", fuel: "95#汽油", area: "机场线", quota: 12000 }
];

/** 申报与实提允许的偏差上限：超过两成转待复核 */
export const REVIEW_TOLERANCE = 0.2;

export type RegisterResult = { ok: true } | { ok: false; reason: string };

export interface RegisterContext {
  vehicle?: SupplyVehicle;
  station?: SupplyStation;
  /** 该车牌当前挂着的未完成单（由状态层过滤后传入） */
  openOrders: SupplyOrder[];
  availableQuota: number;
}

/**
 * 登记核销单的整单校验。任一条件不满足即整单拒绝，
 * 拒绝时不产生单据，额度、库存等原数值一律不动。
 */
export function evaluateRegister(
  input: { plate: string; stationId: string; declared: number },
  ctx: RegisterContext
): RegisterResult {
  if (!ctx.vehicle) {
    return { ok: false, reason: "车牌不在应急保供车辆名录" };
  }
  if (!ctx.station) {
    return { ok: false, reason: "提油站点不存在" };
  }
  if (!Number.isFinite(input.declared) || input.declared <= 0) {
    return { ok: false, reason: "申报量必须是大于 0 的升数" };
  }
  if (ctx.vehicle.fuel !== ctx.station.fuel) {
    return {
      ok: false,
      reason: `油品不符（车辆 ${ctx.vehicle.fuel} / 站点 ${ctx.station.fuel}）`
    };
  }
  if (ctx.vehicle.area !== ctx.station.area) {
    return {
      ok: false,
      reason: `区域不符（车辆属 ${ctx.vehicle.area} / 站点属 ${ctx.station.area}）`
    };
  }
  if (ctx.openOrders.length > 0) {
    return { ok: false, reason: `车牌 ${input.plate} 已有未完成核销单，一车限挂一单` };
  }
  const stockAfter = ctx.station.stock - input.declared;
  if (stockAfter < ctx.station.floorStock) {
    return {
      ok: false,
      reason: `提后库存 ${stockAfter}L 低于保底 ${ctx.station.floorStock}L`
    };
  }
  if (input.declared > ctx.availableQuota) {
    return {
      ok: false,
      reason: `超出可用额度（申报 ${input.declared}L / 可用 ${ctx.availableQuota}L）`
    };
  }
  return { ok: true };
}

/** 实提相对申报的偏差比例 */
export function deviationRatio(declared: number, actual: number): number {
  if (declared <= 0) return 0;
  return Math.abs(actual - declared) / declared;
}

/** 偏差超过两成即转待复核 */
export function needsReview(declared: number, actual: number): boolean {
  return deviationRatio(declared, actual) > REVIEW_TOLERANCE;
}
