<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { VEHICLES } from "./rules";
import {
  STATUS_META,
  allOrders,
  bindStationRecords,
  cancelOrder,
  confirmReview,
  openOrders,
  registerOrder,
  stationView,
  statusLabel,
  submitActual,
  vehicleQuotas
} from "./status";

// App.vue 已在挂载前完成站点绑定，这里直接读取视图即可
const stations = computed(() => stationView());
const orders = allOrders();
const quotas = computed(() => vehicleQuotas());

const filter = ref<"open" | "all">("open");
const filteredOrders = computed(() =>
  filter.value === "open" ? openOrders.value : orders.value
);

const registerForm = reactive({
  plate: "",
  stationId: "",
  declared: null as number | null
});
const registerMessage = ref<{ ok: boolean; text: string } | null>(null);

// 各单的实提量 / 复核原因草稿，避免空输入时冲掉数字
const actualDrafts = reactive<Record<string, string>>({});
const reasonDrafts = reactive<Record<string, string>>({});

function selectedVehicle() {
  return VEHICLES.find((vehicle) => vehicle.plate === registerForm.plate);
}
function selectedStation() {
  return stations.value.find((station) => station.id === registerForm.stationId);
}

const previewStockAfter = computed(() => {
  const station = selectedStation();
  if (!station || registerForm.declared === null) return null;
  return station.stock - registerForm.declared;
});

function submitRegister() {
  registerMessage.value = null;
  if (!registerForm.plate) {
    registerMessage.value = { ok: false, text: "请选择保供车牌" };
    return;
  }
  if (!registerForm.stationId) {
    registerMessage.value = { ok: false, text: "请选择提油站点" };
    return;
  }
  const result = registerOrder({
    plate: registerForm.plate,
    stationId: registerForm.stationId,
    declared: Number(registerForm.declared)
  });
  registerMessage.value = { ok: result.ok, text: result.message };
  // 整单拒绝时不清表单、不动任何数值；成功才复位
  if (result.ok) {
    registerForm.plate = "";
    registerForm.stationId = "";
    registerForm.declared = null;
  }
}

function doSubmitActual(orderId: string) {
  const raw = actualDrafts[orderId];
  const actual = Number(raw);
  if (raw === "" || raw === undefined || !Number.isFinite(actual) || actual < 0) {
    actualDrafts[orderId] = String(actual);
    return;
  }
  const result = submitActual(orderId, actual);
  flash(orderId, result);
  if (result.ok) delete actualDrafts[orderId];
}

function doConfirmReview(orderId: string) {
  const result = confirmReview(orderId, reasonDrafts[orderId] ?? "");
  flash(orderId, result);
  if (result.ok) delete reasonDrafts[orderId];
}

function doCancel(orderId: string) {
  const result = cancelOrder(orderId);
  flash(orderId, result);
}

const flashes = reactive<Record<string, { ok: boolean; text: string }>>({});
function flash(orderId: string, result: { ok: boolean; message: string }) {
  flashes[orderId] = { ok: result.ok, text: result.message };
}

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes()
  ).padStart(2, "0")}`;
}

function deviationText(order: (typeof orders.value)[number]): string {
  if (order.actual === null) return "—";
  const ratio = (Math.abs(order.actual - order.declared) / order.declared) * 100;
  return `${ratio.toFixed(1)}%`;
}

const registerIntro =
  "规则：油品或区域不符、提后低于站点保底、同一车辆已有未完成单、或超出可用额度，均整单拒绝且额度库存不动；登记即按申报量冻结额度。";
</script>

<template>
  <div class="emergency">
    <p class="desk-intro">{{ registerIntro }}</p>

    <section class="quota-grid">
      <article v-for="view in quotas" :key="view.vehicle.plate" class="quota-card">
        <div class="quota-head">
          <p class="quota-plate">{{ view.vehicle.plate }}</p>
          <span class="quota-badge">{{ view.openCount }} 单在途</span>
        </div>
        <p class="quota-meta">{{ view.vehicle.fuel }} · {{ view.vehicle.area }}</p>
        <div class="quota-row">
          <span>总额度</span><strong>{{ view.vehicle.quota }}L</strong>
        </div>
        <div class="quota-row frozen">
          <span>冻结（未完成申报）</span><strong>{{ view.frozen }}L</strong>
        </div>
        <div class="quota-row used">
          <span>已核销（实提）</span><strong>{{ view.used }}L</strong>
        </div>
        <div class="quota-row available" :class="{ low: view.available <= 0 }">
          <span>可用额度</span><strong>{{ view.available }}L</strong>
        </div>
      </article>
    </section>

    <section class="workspace">
      <form class="panel" @submit.prevent="submitRegister">
        <h2>登记核销单</h2>
        <div class="form-grid">
          <label>
            保供车牌
            <select v-model="registerForm.plate" required>
              <option value="">请选择保供车辆</option>
              <option v-for="vehicle in VEHICLES" :key="vehicle.plate" :value="vehicle.plate">
                {{ vehicle.plate }}（{{ vehicle.fuel }} / {{ vehicle.area }}）
              </option>
            </select>
          </label>
          <label>
            提油站点
            <select v-model="registerForm.stationId" required>
              <option value="">请选择站点</option>
              <option v-for="station in stations" :key="station.id" :value="station.id">
                {{ station.station }}（{{ station.fuel }} / {{ station.area }} /
                库存 {{ station.stock }}L / 保底 {{ station.floorStock }}L）
              </option>
            </select>
          </label>
          <label>
            申报量 L
            <input
              v-model.number="registerForm.declared"
              type="number"
              min="1"
              step="1"
              placeholder="按申报量冻结额度"
              required
            />
          </label>
        </div>
        <p v-if="selectedVehicle()" class="hint">
          车辆准入：{{ selectedVehicle()!.fuel }} / {{ selectedVehicle()!.area }}
        </p>
        <p
          v-if="previewStockAfter !== null && selectedStation()"
          class="hint"
          :class="{ 'hint-bad': previewStockAfter < selectedStation()!.floorStock }"
        >
          提后站点库存：{{ previewStockAfter }}L，
          保底 {{ selectedStation()!.floorStock }}L
          <template v-if="previewStockAfter < selectedStation()!.floorStock">
            —— 低于保底，提交将整单拒绝
          </template>
        </p>
        <div v-if="registerMessage" class="desk-message" :class="registerMessage.ok ? 'ok' : 'bad'">
          {{ registerMessage.text }}
        </div>
        <button type="submit" class="desk-submit">登记并冻结额度</button>
      </form>

      <section class="list-panel">
        <div class="toolbar">
          <h2>核销单据</h2>
          <select v-model="filter">
            <option value="open">仅未完成</option>
            <option value="all">全部单据</option>
          </select>
        </div>

        <div class="record-grid">
          <div v-if="filteredOrders.length === 0" class="empty">暂无单据</div>
          <article v-for="order in filteredOrders" :key="order.id" class="record">
            <div class="record-head">
              <p class="record-title">{{ order.plate }} → {{ order.stationName }}</p>
              <span :class="STATUS_META[order.status].kind">{{ statusLabel(order.status) }}</span>
            </div>
            <div class="details">
              <span>油品: {{ order.fuel }}</span>
              <span>区域: {{ order.area }}</span>
              <span>申报量: {{ order.declared }}L</span>
              <span>实提量: {{ order.actual === null ? "待填报" : `${order.actual}L` }}</span>
              <span>偏差: {{ deviationText(order) }}</span>
              <span>登记: {{ formatTime(order.createdAt) }}</span>
            </div>

            <div v-if="order.status === 'active'" class="review-box">
              <label>
                实提量 L
                <input
                  v-model="actualDrafts[order.id]"
                  type="number"
                  min="0"
                  step="1"
                  placeholder="实提与申报差超两成将转待复核"
                />
              </label>
              <div class="actions">
                <button type="button" @click="doSubmitActual(order.id)">完成核销</button>
                <button class="danger" type="button" @click="doCancel(order.id)">取消并解冻额度</button>
              </div>
            </div>

            <div v-else-if="order.status === 'reviewing'" class="review-box">
              <p class="note">实提 {{ order.actual }}L 与申报 {{ order.declared }}L
                偏差 {{ deviationText(order) }}，额度继续占用；补写差异原因并确认后才扣库存和额度。</p>
              <label>
                差异原因
                <textarea
                  v-model="reasonDrafts[order.id]"
                  placeholder="例如：现场液位计偏差 / 站点罐容不足分批提油"
                />
              </label>
              <div class="actions">
                <button type="button" @click="doConfirmReview(order.id)">补写原因并确认</button>
                <button class="danger" type="button" @click="doCancel(order.id)">取消并解冻额度</button>
              </div>
            </div>

            <p v-else-if="order.status === 'done'" class="note">
              已于 {{ formatTime(order.finishedAt) }} 完成，实提 {{ order.actual }}L
              <template v-if="order.reviewReason">，复核原因：{{ order.reviewReason }}</template>
            </p>
            <p v-else class="note">已于 {{ formatTime(order.finishedAt) }} 取消，额度已解冻，库存未动。</p>

            <div v-if="flashes[order.id]" class="desk-message" :class="flashes[order.id].ok ? 'ok' : 'bad'">
              {{ flashes[order.id].text }}
            </div>
          </article>
        </div>
      </section>
    </section>
  </div>
</template>
