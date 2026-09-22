// 应急保供核销台 —— 规则层
// 只放纯业务规则与类型：校验、额度测算、偏差判定。不读存储、不持有状态。

export type FuelType = "92#汽油" | "95#汽油" | "0#柴油";
export type Area = "东区" | "西区" | "机场线";
export type OrderStatus = "待处理" | "待复核" | "已完成" | "已取消";

export interface Truck {
  plate: string;
  fuelType: FuelType;
  area: Area;
  /** 单车总额度 L */
  quota: number;
}

export interface StationMaster {
  station: string;
  area: Area;
  fuelType: FuelType;
  /** 保底库存 L */
  floorStock: number;
}

export interface SupplyOrder {
  id: string;
  plate: string;
  station: string;
  area: Area;
  fuelType: FuelType;
  declaredLiters: number;
  actualLiters: number | null;
  status: OrderStatus;
  /** 待复核转已完成时补写的原因 */
  reviewReason: string;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface Snapshot {
  orders: SupplyOrder[];
  stationStock: Record<string, number>;
}

export interface RegisterInput {
  plate: string;
  station: string;
  declaredLiters: number;
  note: string;
}

export interface RuleContext {
  trucks: readonly Truck[];
  stations: readonly StationMaster[];
  stockByStation: Record<string, number>;
  orders: readonly SupplyOrder[];
}

/** 申报与实提偏差允许比例：两成 */
export const DEVIATION_LIMIT = 0.2;

export const OPEN_STATUSES: readonly OrderStatus[] = ["待处理", "待复核"];

export function isUnfinished(status: OrderStatus): boolean {
  return (OPEN_STATUSES as readonly string[]).includes(status);
}

/** 车辆当前被未完成单占用的额度（申报量口径） */
export function occupiedQuota(orders: readonly SupplyOrder[], plate: string): number {
  return orders
    .filter((order) => order.plate === plate && isUnfinished(order.status))
    .reduce((sum, order) => sum + order.declaredLiters, 0);
}

export function availableQuota(truck: Truck, orders: readonly SupplyOrder[]): number {
  return truck.quota - occupiedQuota(orders, truck.plate);
}

/** |实提-申报| / 申报 */
export function deviationRate(declaredLiters: number, actualLiters: number): number {
  if (declaredLiters <= 0) return 0;
  return Math.abs(actualLiters - declaredLiters) / declaredLiters;
}

export function exceedsDeviation(declaredLiters: number, actualLiters: number): boolean {
  return deviationRate(declaredLiters, actualLiters) > DEVIATION_LIMIT;
}

/**
 * 登记校验。返回全部拒收原因；返回空数组表示通过。
 * 任一规则不通过都整单拒绝，调用方不得改动任何原有数值。
 */
export function validateRegister(input: RegisterInput, context: RuleContext): string[] {
  const errors: string[] = [];
  const truck = context.trucks.find((item) => item.plate === input.plate);
  const station = context.stations.find((item) => item.station === input.station);

  if (!truck) errors.push("车牌未登记，无法匹配保供车辆");
  if (!station) errors.push("站点未在保供名录中");
  if (!(input.declaredLiters > 0)) errors.push("申报量必须为大于 0 的数字（L）");

  if (truck && station) {
    if (truck.area !== station.area) {
      errors.push(`区域不符：车辆负责${truck.area}，站点属${station.area}`);
    }
    if (truck.fuelType !== station.fuelType) {
      errors.push(`油品不符：车辆运载${truck.fuelType}，站点需要${station.fuelType}`);
    }

    const stock = context.stockByStation[station.station] ?? 0;
    const stockAfter = stock - (input.declaredLiters > 0 ? input.declaredLiters : 0);
    if (input.declaredLiters > 0 && stockAfter < station.floorStock) {
      errors.push(
        `提货后库存 ${stockAfter}L 低于保底库存 ${station.floorStock}L（当前库存 ${stock}L）`
      );
    }

    if (context.orders.some((order) => order.plate === truck.plate && isUnfinished(order.status))) {
      errors.push("该车辆已有未完成单据，需先取消或办结");
    }

    if (input.declaredLiters > 0) {
      const rest = availableQuota(truck, context.orders);
      if (input.declaredLiters > rest) {
        errors.push(`额度不足：申报 ${input.declaredLiters}L，剩余可用 ${rest}L`);
      }
    }
  }

  return errors;
}

/** 完成提货时的实提量校验 */
export function validateComplete(actualLiters: number): string[] {
  const errors: string[] = [];
  if (!(actualLiters > 0)) errors.push("实提量必须为大于 0 的数字（L）");
  return errors;
}

/** 待复核单确认前必须补写原因 */
export function validateReview(reviewReason: string): string[] {
  const errors: string[] = [];
  if (!reviewReason.trim()) errors.push("偏差超过两成，必须补写差异原因后才能确认");
  return errors;
}
