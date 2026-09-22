// 应急保供核销台 —— 存储层
// 只负责 localStorage 的读写、默认种子与版本兼容，不含任何业务判断。

import type { Snapshot, StationMaster, SupplyOrder, Truck } from "./rules";

const STORAGE_KEY = "hxwlfront-21-emergency-desk-v1";

export const SEED_TRUCKS: Truck[] = [
  { plate: "沪A·B0501", fuelType: "92#汽油", area: "东区", quota: 30000 },
  { plate: "沪A·B0502", fuelType: "0#柴油", area: "西区", quota: 25000 },
  { plate: "沪A·B0503", fuelType: "95#汽油", area: "机场线", quota: 20000 }
];

export const SEED_STATIONS: StationMaster[] = [
  { station: "东区一站", area: "东区", fuelType: "92#汽油", floorStock: 12000 },
  { station: "西区大道站", area: "西区", fuelType: "0#柴油", floorStock: 8000 },
  { station: "机场快线站", area: "机场线", fuelType: "95#汽油", floorStock: 6000 }
];

const SEED_STOCK: Record<string, number> = {
  "东区一站": 36000,
  "西区大道站": 21000,
  "机场快线站": 9000
};

export function seedSnapshot(): Snapshot {
  return {
    orders: [],
    stationStock: { ...SEED_STOCK }
  };
}

function normalize(raw: unknown): Snapshot {
  const seed = seedSnapshot();
  if (!raw || typeof raw !== "object") return seed;
  const data = raw as Partial<Snapshot>;
  return {
    orders: Array.isArray(data.orders) ? (data.orders as SupplyOrder[]) : seed.orders,
    stationStock:
      data.stationStock && typeof data.stationStock === "object"
        ? { ...seed.stationStock, ...(data.stationStock as Record<string, number>) }
        : seed.stationStock
  };
}

export function loadSnapshot(): Snapshot {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return seedSnapshot();
  try {
    return normalize(JSON.parse(raw));
  } catch {
    return seedSnapshot();
  }
}

export function saveSnapshot(snapshot: Snapshot): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
}

export function resetSnapshot(): Snapshot {
  const seed = seedSnapshot();
  saveSnapshot(seed);
  return seed;
}
