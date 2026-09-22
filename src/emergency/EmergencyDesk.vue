<script setup lang="ts">
// 应急保供核销台页面：只负责交互与展示，规则走 rules.ts、状态走 desk.ts、存取走 storage.ts
import { computed, reactive, ref } from "vue";
import { useEmergencyDesk } from "./desk";
import type { OrderStatus, SupplyOrder } from "./rules";

const {
  trucks,
  truckSummaries,
  stations,
  orders,
  stationStock,
  register,
  cancel,
  complete,
  confirmReview,
  resetAll
} = useEmergencyDesk();

const FILTERS: Array<"全部" | OrderStatus> = ["全部", "待处理", "待复核", "已完成", "已取消"];

const form = reactive({ plate: "", station: "", declaredLiters: "", note: "" });
const formErrors = ref<string[]>([]);
const feedback = ref<{ type: "ok" | "err"; text: string } | null>(null);
const statusFilter = ref<(typeof FILTERS)[number]>("全部");

// 内联操作面板状态
const completingId = ref<string | null>(null);
const completingLiters = ref("");
const completingErrors = ref<string[]>([]);
const reviewingId = ref<string | null>(null);
const reviewingReason = ref("");
const reviewingErrors = ref<string[]>([]);

const filteredOrders = computed(() => {
  if (statusFilter.value === "全部") return orders.value;
  return orders.value.filter((order) => order.status === statusFilter.value);
});

const selectedTruck = computed(() => trucks.find((truck) => truck.plate === form.plate));
const selectedStation = computed(() =>
  stations.find((station) => station.station === form.station)
);
const declared = computed(() => Number(form.declaredLiters));

const predictedStockAfter = computed(() => {
  if (!selectedStation.value || !(declared.value > 0)) return null;
  const stock = stationStock.value[selectedStation.value.station] ?? 0;
  return stock - declared.value;
});

const selectedTruckSummary = computed(() =>
  truckSummaries.value.find((truck) => truck.plate === form.plate)
);

function setFeedback(type: "ok" | "err", text: string) {
  feedback.value = { type, text };
}

function submitRegister() {
  formErrors.value = [];
  feedback.value = null;
  const result = register({
    plate: form.plate,
    station: form.station,
    declaredLiters: Number(form.declaredLiters),
    note: form.note
  });
  if (!result.ok) {
    // 整单拒绝：保留输入，不动任何数值
    formErrors.value = result.errors ?? ["登记失败"];
    setFeedback("err", "登记被拒绝，车辆额度与站点库存均未变化");
    return;
  }
  setFeedback("ok", "登记成功，申报量已占用该车辆额度");
  form.plate = "";
  form.station = "";
  form.declaredLiters = "";
  form.note = "";
}

function cancelOrder(order: SupplyOrder) {
  const result = cancel(order.id);
  if (!result.ok) {
    setFeedback("err", (result.errors ?? ["取消失败"]).join("；"));
    return;
  }
  resetInline();
  setFeedback("ok", `单据已取消，${order.declaredLiters}L 额度已解冻`);
}

function startComplete(order: SupplyOrder) {
  resetInline();
  completingId.value = order.id;
  completingLiters.value = String(order.declaredLiters);
}

function submitComplete(order: SupplyOrder) {
  completingErrors.value = [];
  const result = complete(order.id, Number(completingLiters.value));
  if (!result.ok) {
    completingErrors.value = result.errors ?? ["操作失败"];
    return;
  }
  resetInline();
  setFeedback(
    "ok",
    result.review
      ? "实提与申报偏差超过两成，已转待复核；额度继续占用，补写原因并确认后才减库存"
      : "提货已办结，站点库存与车辆额度已同步核减"
  );
}

function startReview(order: SupplyOrder) {
  resetInline();
  reviewingId.value = order.id;
  reviewingReason.value = order.reviewReason;
}

function submitReview(order: SupplyOrder) {
  reviewingErrors.value = [];
  const result = confirmReview(order.id, reviewingReason.value);
  if (!result.ok) {
    reviewingErrors.value = result.errors ?? ["操作失败"];
    return;
  }
  resetInline();
  setFeedback("ok", "复核确认完成，已按实提量核减库存并释放额度");
}

function resetInline() {
  completingId.value = null;
  completingLiters.value = "";
  completingErrors.value = [];
  reviewingId.value = null;
  reviewingReason.value = "";
  reviewingErrors.value = [];
}

function deviationPercent(order: SupplyOrder): string {
  if (order.actualLiters == null) return "-";
  const rate = Math.abs(order.actualLiters - order.declaredLiters) / order.declaredLiters;
  return `${(rate * 100).toFixed(1)}%`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}

function resetAllData() {
  if (!window.confirm("确定清空全部保供单据并恢复初始库存与额度？")) return;
  resetAll();
  resetInline();
  formErrors.value = [];
  setFeedback("ok", "已恢复到初始演示数据");
}
</script>

<template>
  <section class="desk">
    <div class="desk-head">
      <div>
        <h2>应急保供核销台</h2>
        <p class="desk-sub">
          三辆保供车按油品、区域、额度执行任务；登记即冻结申报额度，偏差超两成须复核，取消即解冻。
        </p>
      </div>
      <button class="secondary" type="button" @click="resetAllData">恢复初始数据</button>
    </div>

    <div class="resource-grid">
      <article v-for="truck in truckSummaries" class="resource-card truck" :key="truck.plate">
        <div class="resource-title">
          <strong>{{ truck.plate }}</strong>
          <span class="chip">{{ truck.area }} · {{ truck.fuelType }}</span>
        </div>
        <div class="quota-track">
          <div class="quota-fill" :style="{ width: `${(truck.occupied / truck.quota) * 100}%` }" />
        </div>
        <p class="quota-text">
          总额度 {{ truck.quota }}L ｜ 已占 {{ truck.occupied }}L ｜
          <em :class="{ low: truck.available <= 0 }">可用 {{ truck.available }}L</em>
        </p>
      </article>

      <article v-for="station in stations" class="resource-card station" :key="station.station">
        <div class="resource-title">
          <strong>{{ station.station }}</strong>
          <span class="chip">{{ station.area }} · {{ station.fuelType }}</span>
        </div>
        <p class="quota-text">
          当前库存 <em>{{ stationStock[station.station] ?? 0 }}L</em> ｜
          保底库存 {{ station.floorStock }}L
        </p>
      </article>
    </div>

    <div v-if="feedback" class="feedback" :class="feedback.type">{{ feedback.text }}</div>

    <div class="desk-body">
      <form class="panel register-form" @submit.prevent="submitRegister">
        <h3>保供登记</h3>
        <label>
          保供车牌
          <select v-model="form.plate" required>
            <option value="">请选择车辆</option>
            <option v-for="truck in trucks" :key="truck.plate" :value="truck.plate">
              {{ truck.plate }}（{{ truck.area }} · {{ truck.fuelType }}）
            </option>
          </select>
        </label>
        <label>
          保供站点
          <select v-model="form.station" required>
            <option value="">请选择站点</option>
            <option v-for="station in stations" :key="station.station" :value="station.station">
              {{ station.station }}（{{ station.area }} · {{ station.fuelType }}）
            </option>
          </select>
        </label>
        <label>
          申报量 L
          <input v-model="form.declaredLiters" type="number" min="1" step="1" placeholder="例如 8000" required />
        </label>
        <label>
          备注
          <textarea v-model="form.note" placeholder="任务说明、现场情况（选填）" />
        </label>

        <ul v-if="formErrors.length" class="error-list">
          <li v-for="item in formErrors" :key="item">× {{ item }}</li>
        </ul>

        <div v-if="selectedTruck || selectedStation" class="preview">
          <p v-if="selectedTruckSummary">
            车辆可用额度：{{ selectedTruckSummary.available }}L
          </p>
          <p v-if="selectedStation">
            站点当前库存：{{ stationStock[selectedStation.station.station] ?? 0 }}L，
            保底 {{ selectedStation.floorStock }}L
          </p>
          <p v-if="predictedStockAfter !== null" :class="{ low: predictedStockAfter < (selectedStation?.floorStock ?? 0) }">
            提后预计库存：{{ predictedStockAfter }}L
            <span v-if="predictedStockAfter < (selectedStation?.floorStock ?? 0)">（低于保底，将被拒绝）</span>
          </p>
        </div>

        <button type="submit">提交登记</button>
      </form>

      <section class="list-panel order-list">
        <div class="toolbar">
          <h3>保供单据</h3>
          <select v-model="statusFilter" class="filter-select">
            <option v-for="item in FILTERS" :key="item" :value="item">{{ item }}</option>
          </select>
        </div>

        <div v-if="filteredOrders.length === 0" class="empty">暂无匹配单据</div>

        <article v-for="order in filteredOrders" :key="order.id" class="order">
          <div class="order-head">
            <p class="order-title">{{ order.plate }} → {{ order.station }}</p>
            <span class="status" :data-status="order.status">{{ order.status }}</span>
          </div>
          <div class="details">
            <span>区域：{{ order.area }}</span>
            <span>油品：{{ order.fuelType }}</span>
            <span>申报：{{ order.declaredLiters }}L</span>
            <span>实提：{{ order.actualLiters ?? "—" }}L</span>
            <span v-if="order.actualLiters != null">偏差：{{ deviationPercent(order) }}</span>
            <span>登记时间：{{ formatTime(order.createdAt) }}</span>
          </div>
          <p v-if="order.note" class="note">备注：{{ order.note }}</p>
          <p v-if="order.status === '已完成' && order.reviewReason" class="note review-note">
            复核原因：{{ order.reviewReason }}
          </p>

          <ul v-if="completingId === order.id && completingErrors.length" class="error-list">
            <li v-for="item in completingErrors" :key="item">× {{ item }}</li>
          </ul>
          <div v-if="completingId === order.id && order.status === '待处理'" class="inline-form">
            <label>
              实提量 L
              <input v-model="completingLiters" type="number" min="1" step="1" />
            </label>
            <div class="inline-actions">
              <button type="button" @click="submitComplete(order)">确认提货</button>
              <button class="secondary" type="button" @click="resetInline">返回</button>
            </div>
          </div>

          <ul v-if="reviewingId === order.id && reviewingErrors.length" class="error-list">
            <li v-for="item in reviewingErrors" :key="item">× {{ item }}</li>
          </ul>
          <div v-if="reviewingId === order.id && order.status === '待复核'" class="inline-form">
            <label>
              差异原因（必填）
              <textarea v-model="reviewingReason" placeholder="说明实提与申报偏差超过两成的原因" />
            </label>
            <div class="inline-actions">
              <button type="button" @click="submitReview(order)">补写原因并确认</button>
              <button class="secondary" type="button" @click="resetInline">返回</button>
            </div>
          </div>

          <div class="actions">
            <template v-if="order.status === '待处理'">
              <button v-if="completingId !== order.id" type="button" @click="startComplete(order)">完成提货</button>
              <button class="danger" type="button" @click="cancelOrder(order)">取消单据</button>
            </template>
            <template v-else-if="order.status === '待复核'">
              <button v-if="reviewingId !== order.id" type="button" @click="startReview(order)">补写原因并复核</button>
              <button class="danger" type="button" @click="cancelOrder(order)">取消单据</button>
            </template>
            <span v-else class="closed-text">
              {{ order.status === "已取消" ? "额度已解冻，库存未变动" : `库存已核减 ${order.actualLiters}L` }}
            </span>
          </div>
        </article>
      </section>
    </div>
  </section>
</template>

<style scoped>
.desk {
  margin-top: 26px;
  border-top: 1px solid #dfe7f1;
  padding-top: 22px;
}

.desk-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 16px;
}

.desk-head h2 {
  margin: 0 0 6px;
  font-size: 22px;
}

.desk-sub {
  margin: 0;
  color: #5b667a;
  font-size: 14px;
  line-height: 1.7;
}

.resource-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}

@media (min-width: 1000px) {
  .resource-grid { grid-template-columns: repeat(6, minmax(0, 1fr)); }
}

.resource-card {
  background: #fff;
  border: 1px solid #dfe7f1;
  border-radius: 8px;
  padding: 12px 14px;
}

.resource-title {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 10px;
}

.chip {
  align-self: flex-start;
  font-size: 12px;
  color: #176b87;
  background: #eaf4f8;
  border-radius: 999px;
  padding: 3px 8px;
}

.quota-track {
  height: 8px;
  border-radius: 999px;
  background: #e7edf4;
  overflow: hidden;
  margin-bottom: 8px;
}

.quota-fill {
  height: 100%;
  background: linear-gradient(90deg, #c84b31, #e0934d);
  border-radius: inherit;
}

.quota-text {
  margin: 0;
  font-size: 12.5px;
  color: #536078;
}

.quota-text em {
  font-style: normal;
  font-weight: 700;
  color: #14724f;
}

.quota-text em.low { color: #c84b31; }

.feedback {
  border-radius: 8px;
  padding: 10px 14px;
  margin-bottom: 14px;
  font-size: 14px;
}

.feedback.ok { background: #e8f4ef; color: #14724f; border: 1px solid #bfe3d3; }
.feedback.err { background: #fbeae7; color: #a33a22; border: 1px solid #f0c4bb; }

.desk-body {
  display: grid;
  grid-template-columns: minmax(280px, 360px) 1fr;
  gap: 18px;
}

.register-form {
  display: grid;
  gap: 12px;
  align-content: start;
  background: #fff;
  border: 1px solid #dfe7f1;
  border-radius: 8px;
  padding: 18px;
}

.register-form h3 { margin: 0; font-size: 18px; }

.preview {
  background: #f3f7fb;
  border-radius: 8px;
  padding: 10px 12px;
  display: grid;
  gap: 4px;
  font-size: 13px;
  color: #445069;
}

.preview p { margin: 0; }
.preview .low { color: #c84b31; font-weight: 700; }

.error-list {
  margin: 0;
  padding: 10px 12px;
  list-style: none;
  background: #fbeae7;
  border: 1px solid #f0c4bb;
  border-radius: 8px;
  color: #a33a22;
  font-size: 13px;
  display: grid;
  gap: 4px;
}

.order-list {
  background: #fff;
  border: 1px solid #dfe7f1;
  border-radius: 8px;
  padding: 18px;
}

.order-list h3 { margin: 0; font-size: 18px; }

.filter-select { width: auto; }

.order {
  border: 1px solid #dfe7f1;
  border-radius: 8px;
  padding: 14px;
  background: #fbfcfe;
  margin-bottom: 12px;
}

.order-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: start;
}

.order-title { margin: 0; font-size: 16px; font-weight: 800; }

.status[data-status="待处理"] { background: #e8f4ef; color: #14724f; }
.status[data-status="待复核"] { background: #fdf3e0; color: #9a6200; }
.status[data-status="已完成"] { background: #e7edf4; color: #3c4a63; }
.status[data-status="已取消"] { background: #f0e3e0; color: #8a3420; }

.inline-form {
  display: grid;
  gap: 10px;
  margin: 10px 0;
  padding: 12px;
  background: #fff;
  border: 1px dashed #cfd8e5;
  border-radius: 8px;
}

.inline-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.review-note { background: #fdf6e8; }

.closed-text {
  font-size: 13px;
  color: #69758c;
}

@media (max-width: 860px) {
  .desk-body { grid-template-columns: 1fr; }
  .resource-grid { grid-template-columns: 1fr; }
}
</style>
