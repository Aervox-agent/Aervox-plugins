<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, unref, watch, type Component } from 'vue';
import { useAervoxLLM, type LLMConfigDto, type LLMProviderType } from '@aervox/api-client';
import { AervoxBrandMark, CompanionAvatar, readCompanionIdentity, saveCompanionIdentity, useCompanionAvatarBinding } from '@aervox/ui/companion';
import { AervoxButton } from '@aervox/ui/primitives';
import { useMobileBackNavigation } from '@aervox/ui/material3';
import type { OnboardingModelStatus } from './onboarding-state';
import { applyOnboardingProvider, validateOnboardingModel } from './onboarding-model';
import './onboarding.css';

const props = withDefaults(defineProps<{ replay?: boolean; modelSetup?: Component }>(), { replay: false });
const emit = defineEmits<{ complete: []; dismiss: []; ready: [] }>();
const llm = props.modelSetup ? undefined : useAervoxLLM();
const titles = ['相遇', '认识彼此', '接入模型', '开始相处'];
const step = ref(0);
const root = ref<HTMLElement>();
const viewportHeight = ref<number>();
function syncViewport() {
  const viewport = window.visualViewport;
  if (viewport && viewport.scale !== 1) return;
  viewportHeight.value = (viewport?.height ?? window.innerHeight) - Math.max(0, (root.value?.getBoundingClientRect().top ?? 0) - (viewport?.offsetTop ?? 0));
  void nextTick(() => {
    const active = document.activeElement;
    if (active instanceof HTMLInputElement && root.value?.contains(active)) active.scrollIntoView({ block: 'nearest' });
  });
}
const heading = ref<HTMLElement>();
const { model: avatarModel, state: avatarBindingState, refresh: refreshAvatarBinding } = useCompanionAvatarBinding();
const nativeModelStatus = ref<OnboardingModelStatus>({ state: 'loading', busy: false });
const identity = ref(readCompanionIdentity());
const identityError = ref('');
const draft = ref<LLMConfigDto>({ enabled: true, providerType: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: '', modelId: 'deepseek-chat', temperature: 0.7, maxTokens: 4096, settings: {} });
const touched = ref(false), loadingConfig = ref(true), loadingProviders = ref(false);
const configError = ref(''), catalogError = ref(''), modelError = ref('');
const isTesting = ref(false), isSaving = ref(false);
const connection = ref<'idle' | 'success' | 'error'>('idle'), connectionMessage = ref('尚未测试连接');
const modelSummary = ref('尚未接入，可以稍后在设置中完成');
const savedModelId = ref('');
const providers = computed(() => unref(llm?.presetProviders) ?? []);
const preset = computed(() => providers.value.find(value => value.id === draft.value.providerType));
const busy = computed(() => isSaving.value || isTesting.value || (step.value === 2 && nativeModelStatus.value.busy));
const fingerprint = () => JSON.stringify([draft.value.providerType, draft.value.baseUrl, draft.value.modelId, draft.value.apiKey]);
let disposed = false, testGeneration = 0;
const backNavigation = useMobileBackNavigation();
let backLayer: ReturnType<NonNullable<typeof backNavigation>['registerLayer']> | undefined;
function syncBackLayer() {
  backLayer?.dispose(); backLayer = undefined;
  backLayer = backNavigation?.registerLayer({ onBack: () => { if (step.value > 0) void goTo(step.value - 1); else void leave(!props.replay); }, canDismiss: () => !busy.value });
}
watch(step, syncBackLayer);
async function leave(complete: boolean) {
  if (busy.value) return;
  backLayer?.close(); backLayer = undefined;
  try { await backNavigation?.whenSettled(); } catch { return; }
  if (!disposed) { if (complete) emit('complete'); else emit('dismiss'); }
}
const cue = computed(() => [
  '在这里，慢慢认识彼此。',
  `你好，我是${identity.value.companionName.trim() || '小隅'}。`,
  '接上模型，我们就能开始对话。',
  `准备好了，${identity.value.userAddress.trim() || '你'}。`,
][step.value]);

async function goTo(index: number) {
  if (busy.value) return;
  step.value = Math.max(0, Math.min(index, 3));
  await nextTick(); heading.value?.focus();
}
function updateNativeModelStatus(status: OnboardingModelStatus) {
  nativeModelStatus.value = status;
  savedModelId.value = status.state === 'configured' ? status.modelId ?? '' : '';
  modelSummary.value = status.state === 'configured' ? '配置已保存，连接可单独测试'
    : status.state === 'error' ? '配置状态暂不可用，现有配置已保留' : '尚未接入，可以稍后在设置中完成';
}
async function saveNames() {
  const name = identity.value.companionName.trim(), address = identity.value.userAddress.trim();
  if (!name || !address || [...name].length > 24 || [...address].length > 24) {
    identityError.value = '名字和称呼都需要填写，最多 24 个字'; return;
  }
  identityError.value = '';
  identity.value = saveCompanionIdentity({ companionName: name, userAddress: address });
  const stored = readCompanionIdentity();
  if (stored.companionName !== name || stored.userAddress !== address) { identityError.value = '称呼未能保存，请检查本机存储权限后重试'; return; }
  await goTo(2);
}
function changeProvider(event: Event) {
  const provider = (event.target as HTMLSelectElement).value as LLMProviderType;
  touched.value = true;
  draft.value = applyOnboardingProvider(draft.value, provider, providers.value.find(value => value.id === provider));
}
watch(fingerprint, () => { connection.value = 'idle'; connectionMessage.value = '配置变更后需要重新测试'; });
function validated() {
  modelError.value = validateOnboardingModel(draft.value, preset.value?.requiresApiKey ?? false) ?? '';
  return !modelError.value;
}
async function testConnection() {
  if (!llm || isTesting.value || !validated()) return;
  const token = ++testGeneration, original = fingerprint();
  isTesting.value = true; connection.value = 'idle'; connectionMessage.value = '正在测试连接…';
  try {
    const result = await llm.testConnection({ providerType: draft.value.providerType, baseUrl: draft.value.baseUrl.trim(), modelId: draft.value.modelId.trim(), apiKey: draft.value.apiKey?.trim() || undefined });
    if (disposed || token !== testGeneration || original !== fingerprint()) return;
    connection.value = result.ok ? 'success' : 'error';
    connectionMessage.value = result.ok ? `连接成功 · ${result.latencyMs} ms` : result.message;
  } catch (error) {
    if (!disposed && token === testGeneration && original === fingerprint()) { connection.value = 'error'; connectionMessage.value = error instanceof Error ? error.message : '连接失败，请检查配置后重试'; }
  } finally { if (token === testGeneration) isTesting.value = false; }
}
async function saveModel() {
  if (!llm || isSaving.value || isTesting.value || loadingConfig.value || configError.value || !validated()) return;
  isSaving.value = true;
  const verified = connection.value === 'success';
  const config = { ...draft.value, enabled: true, baseUrl: draft.value.baseUrl.trim(), modelId: draft.value.modelId.trim(), apiKey: draft.value.apiKey?.trim() || undefined, settings: { ...(draft.value.settings ?? {}) } };
  try {
    await llm.saveConfig(config);
    if (disposed) return;
    savedModelId.value = config.modelId;
    modelSummary.value = verified ? '连接已验证' : '配置已保存，尚未验证连接';
    isSaving.value = false; await goTo(3);
  } catch (error) { if (!disposed) modelError.value = error instanceof Error ? error.message : '配置保存失败，请重试'; }
  finally { isSaving.value = false; }
}
async function loadConfig() {
  if (!llm) return;
  loadingConfig.value = true; configError.value = '';
  try {
    const current = await llm.getConfig();
    if (!disposed && !touched.value) draft.value = current;
    if (!disposed && current.enabled && current.modelId) { savedModelId.value = current.modelId; modelSummary.value = '保留已有配置，连接尚未验证'; }
  } catch { if (!disposed) configError.value = '未能读取已有配置，重试前不会覆盖它'; }
  finally { if (!disposed) loadingConfig.value = false; }
}
async function loadProviders() {
  if (!llm || loadingProviders.value) return;
  loadingProviders.value = true; catalogError.value = '';
  try { await llm.loadProviders(); }
  catch { if (!disposed) catalogError.value = '供应商目录加载失败，当前配置已保留'; }
  finally { if (!disposed) loadingProviders.value = false; }
}
onMounted(async () => {
  syncBackLayer();
  syncViewport();
  window.addEventListener('resize', syncViewport);
  window.visualViewport?.addEventListener('resize', syncViewport);
  void loadConfig(); void loadProviders();
  emit('ready');
});
onBeforeUnmount(() => {
  disposed = true; testGeneration++; backLayer?.dispose();
  window.removeEventListener('resize', syncViewport);
  window.visualViewport?.removeEventListener('resize', syncViewport);
});
</script>

<template>
  <main ref="root" class="onboarding" :data-step="step + 1" :style="{ maxHeight: viewportHeight === undefined ? undefined : `${viewportHeight}px` }">
    <header class="onboarding-top">
      <span class="onboarding-brand"><AervoxBrandMark :size="26" /><strong>思隅</strong><span>Aervox</span></span>
      <button class="onboarding-text-button" type="button" :disabled="busy" @click="leave(!props.replay)">{{ props.replay ? '退出设置' : '稍后设置' }}</button>
    </header>
    <div class="onboarding-layout">
      <aside class="onboarding-presence" aria-label="形象预览">
        <p class="onboarding-greeting">{{ cue }}</p>
        <CompanionAvatar :model="avatarModel" :binding-state="avatarBindingState" :preview="true" class="onboarding-character" @retry-binding="refreshAvatarBinding" />
        <div class="onboarding-character-caption"><strong>{{ identity.companionName.trim() || '小隅' }}</strong><span>{{ avatarModel.displayName }} · Live2D</span></div>
      </aside>
      <section class="onboarding-panel">
        <nav class="onboarding-steps" aria-label="首次配置步骤">
          <button v-for="(title, index) in titles" :key="title" type="button" :aria-current="step === index ? 'step' : undefined" :disabled="busy || index > step" @click="goTo(index)"><span>{{ index + 1 }}</span>{{ title }}</button>
        </nav>
        <div class="onboarding-content">
          <template v-if="step === 0">
            <p class="onboarding-kicker">从一次相遇开始</p>
            <h1 ref="heading" tabindex="-1">你好，欢迎来到思隅。</h1>
            <p class="onboarding-description">保留你正在使用的角色形象。没有绑定形象时，由 Mizuki 陪你开始。</p>
            <p class="onboarding-note">接下来设置名字、称呼与模型服务。人格设定和权限不会自动改变。</p>
            <div class="onboarding-actions"><AervoxButton variant="primary" @click="goTo(1)">认识彼此</AervoxButton></div>
          </template>
          <form v-else-if="step === 1" @submit.prevent="saveNames">
            <p class="onboarding-kicker">名字，让相遇更具体</p>
            <h1 ref="heading" tabindex="-1">想怎么叫我？</h1>
            <p class="onboarding-description">“小隅”是我的默认名字。你可以保留，也可以给我起一个只属于这里的名字。</p>
            <label class="onboarding-field"><span>角色的名字</span><input v-model="identity.companionName" maxlength="24" autocomplete="off" placeholder="小隅" /></label>
            <label class="onboarding-field"><span>我该怎么称呼你</span><input v-model="identity.userAddress" maxlength="24" autocomplete="nickname" placeholder="你喜欢的称呼" /></label>
            <p class="onboarding-note">名字和称呼可以随时在设置里修改，不会改变现有角色预设。</p>
            <p v-if="identityError" class="onboarding-error" role="alert">{{ identityError }}</p>
            <div class="onboarding-actions"><AervoxButton variant="secondary" @click="goTo(0)">上一步</AervoxButton><AervoxButton variant="primary" type="submit" @click.prevent="saveNames">保存名字并继续</AervoxButton></div>
          </form>
          <section v-else-if="step === 2 && modelSetup" class="onboarding-native-model">
            <p class="onboarding-kicker">连接思考的能力</p>
            <h1 ref="heading" tabindex="-1">接上模型，就能聊起来。</h1>
            <component :is="modelSetup" :model-setup-only="true" @model-status="updateNativeModelStatus" />
            <div class="onboarding-actions"><AervoxButton variant="secondary" :disabled="busy" @click="goTo(1)">上一步</AervoxButton><AervoxButton variant="primary" :disabled="busy" @click="goTo(3)">{{ nativeModelStatus.state === 'configured' ? '保留配置并继续' : '稍后接入，保留已有配置' }}</AervoxButton></div>
          </section>
          <form v-else-if="step === 2" @input="touched = true" @submit.prevent="saveModel">
            <p class="onboarding-kicker">连接思考的能力</p>
            <h1 ref="heading" tabindex="-1">接上模型，就能聊起来。</h1>
            <p class="onboarding-description">使用你自己的模型服务。密钥交由当前思隅服务保存，不写入引导的浏览器存储。</p>
            <fieldset :disabled="isSaving || loadingConfig">
              <label class="onboarding-field"><span>服务提供商</span><select :value="draft.providerType" @change="changeProvider"><option v-if="!preset" :value="draft.providerType">{{ draft.providerType }}（当前配置）</option><option v-for="provider in providers" :key="provider.id" :value="provider.id">{{ provider.name }}</option></select></label>
              <div class="onboarding-fields-row"><label class="onboarding-field"><span>服务地址</span><input v-model="draft.baseUrl" type="url" placeholder="https://api.example.com/v1" /></label><label class="onboarding-field"><span>模型 ID</span><input v-model="draft.modelId" placeholder="model-name" list="onboarding-models" /><datalist id="onboarding-models"><option v-for="model in preset?.recommendedModels" :key="model" :value="model" /></datalist></label></div>
              <label class="onboarding-field"><span>API Key <small v-if="!preset?.requiresApiKey">（按服务需要填写）</small></span><input v-model="draft.apiKey" type="password" autocomplete="off" spellcheck="false" placeholder="输入服务密钥" /></label>
            </fieldset>
            <div v-if="catalogError" class="onboarding-feedback"><p role="alert">{{ catalogError }}</p><button type="button" :disabled="loadingProviders" @click="loadProviders">重新加载供应商目录</button></div>
            <div v-if="configError" class="onboarding-feedback"><p role="alert">{{ configError }}</p><button type="button" :disabled="loadingConfig" @click="loadConfig">重新读取已有配置</button></div>
            <div class="onboarding-connection" :data-connection="connection"><AervoxButton :loading="isTesting" :disabled="isSaving || loadingConfig || Boolean(configError)" @click="testConnection">测试连接</AervoxButton><span role="status">{{ connectionMessage }}</span></div>
            <p v-if="modelError" class="onboarding-error" role="alert">{{ modelError }}</p>
            <div class="onboarding-actions"><AervoxButton variant="secondary" @click="goTo(1)">上一步</AervoxButton><AervoxButton variant="primary" :loading="isSaving" :disabled="isTesting || loadingConfig || Boolean(configError)" @click="saveModel">保存配置并继续</AervoxButton></div>
            <button type="button" class="onboarding-text-button onboarding-skip" :disabled="busy || isTesting || loadingConfig" @click="goTo(3)">稍后接入，保留已有配置</button>
          </form>
          <template v-else>
            <p class="onboarding-kicker">从这里，开始日常</p>
            <h1 ref="heading" tabindex="-1">{{ identity.userAddress }}，很高兴认识你。</h1>
            <p class="onboarding-description">以后，叫我“{{ identity.companionName }}”就好。聊聊今天、整理一个想法，或一起推进一件小事。</p>
            <dl class="onboarding-summary"><div><dt>你的陪伴</dt><dd>{{ identity.companionName }} · {{ avatarModel.displayName }}</dd></div><div><dt>模型连接</dt><dd>{{ savedModelId || '稍后接入' }}<small>{{ modelSummary }}</small></dd></div><div><dt>由你决定</dt><dd>通知、语音和其他权限按使用需要开启</dd></div></dl>
            <p class="onboarding-note">设置里可以重新打开这份引导。现在不会自动发送消息或开启麦克风。</p>
            <div class="onboarding-actions"><AervoxButton variant="secondary" @click="goTo(2)">返回检查</AervoxButton><AervoxButton variant="primary" @click="leave(true)">开始相处</AervoxButton></div>
          </template>
        </div>
      </section>
    </div>
  </main>
</template>
