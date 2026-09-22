// 应急保供核销台 · 存储层
// 只管核销单在 localStorage 的读写；规则判断不放在这里。
import type { SupplyOrder } from "./rules";

export const ORDER_STORAGE_KEY = "hxwlfront-21-emergency-orders";

export function loadOrders(): SupplyOrder[] {
  const raw = localStorage.getItem(ORDER_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SupplyOrder[]) : [];
  } catch {
    return [];
  }
}

export function saveOrders(orders: SupplyOrder[]): void {
  localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(orders));
}
