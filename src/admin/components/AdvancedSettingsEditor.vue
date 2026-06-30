<script setup lang="ts">
  import { computed } from 'vue'
  import type { MusicConfig } from '../../types/music'
  import BaseInput from '../../components/BaseInput.vue'
  import BaseTextarea from '../../components/BaseTextarea.vue'
  import ToggleSwitch from '../../components/ToggleSwitch.vue'

  const props = defineProps<{ config: MusicConfig }>()
  const emit = defineEmits<{ 'update:config': [value: MusicConfig] }>()

  type AdvancedKey = 'githubProxy' | 'customCss' | 'customJs'

  function updateTextField(key: AdvancedKey, value: string) {
    const next = { ...props.config }
    if (value.trim()) {
      next[key] = value
    } else {
      delete next[key]
    }
    emit('update:config', next)
  }

  const githubProxy = computed({
    get: () => props.config.githubProxy || '',
    set: (value: string) => updateTextField('githubProxy', value),
  })

  const receivePrereleaseUpdates = computed({
    get: () => props.config.receivePrereleaseUpdates === true,
    set: (value: boolean) =>
      emit('update:config', {
        ...props.config,
        receivePrereleaseUpdates: value,
      }),
  })

  const customCss = computed({
    get: () => props.config.customCss || '',
    set: (value: string) => updateTextField('customCss', value),
  })

  const customJs = computed({
    get: () => props.config.customJs || '',
    set: (value: string) => updateTextField('customJs', value),
  })
</script>

<template>
  <div class="advanced-editor">
    <div class="admin-section">
      <h3 class="section-title">高级</h3>

      <div class="setting-row proxy-row">
        <span class="row-label">
          <strong>GitHub 代理</strong>
          <small>用于检查更新,并在更新流程中拉取上游代码</small>
        </span>
        <div class="proxy-field">
          <BaseInput v-model="githubProxy" type="url" placeholder="https://gh-proxy.example.com/" />
          <p v-if="githubProxy" class="proxy-warning">
            仅使用你信任的代理。代理会参与拉取上游仓库代码,恶意代理可能注入代码。触发更新流程仍需要部署环境可访问
            api.github.com。
          </p>
        </div>
      </div>

      <div class="setting-row">
        <span class="row-label">
          <strong>接收预发布版本</strong>
          <small>稳定版也检查 rc、beta、alpha 等预发布更新</small>
        </span>
        <ToggleSwitch v-model="receivePrereleaseUpdates" />
      </div>
    </div>

    <div class="admin-section">
      <h3 class="section-title">自定义</h3>

      <div class="code-row">
        <span class="row-label">
          <strong>自定义 CSS</strong>
          <small>会注入到播放器页面</small>
        </span>
        <BaseTextarea
          v-model="customCss"
          spellcheck="false"
          placeholder=":root { --accent: #81d8d0; }"
        />
      </div>

      <div class="code-row">
        <span class="row-label">
          <strong>自定义 JS</strong>
          <small>会在播放器页面加载后执行</small>
        </span>
        <BaseTextarea v-model="customJs" spellcheck="false" placeholder="console.log('Meliora')" />
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
  .advanced-editor {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .admin-section {
    overflow: hidden;
    border: 1px solid rgba(255, 255, 255, 0.11);
    border-radius: 22px;
    background: rgba(255, 255, 255, 0.075);
    box-shadow: inset 0 1px rgba(255, 255, 255, 0.045);
    backdrop-filter: blur(22px);
  }

  .section-title {
    margin: 0;
    padding: 12px 14px 10px;
    color: rgba(255, 255, 255, 0.48);
    font-size: 0.62rem;
    font-weight: 680;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .setting-row,
  .code-row {
    display: flex;
    gap: 14px;
    padding: 15px 14px;
    border-top: 1px solid rgba(255, 255, 255, 0.075);
  }

  .setting-row {
    align-items: center;
    justify-content: space-between;
  }

  .proxy-row {
    align-items: flex-start;
  }

  .proxy-field {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }

  .proxy-warning {
    margin: 0;
    color: rgba(255, 200, 120, 0.82);
    font-size: 0.66rem;
    line-height: 1.4;
  }

  .code-row {
    align-items: flex-start;
    flex-direction: column;
  }

  .row-label {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex-shrink: 0;

    strong {
      color: #fff;
      font-size: 0.86rem;
      font-weight: 560;
    }

    small {
      color: var(--text-subtle);
      font-size: 0.7rem;
    }
  }

  @media (max-width: 720px) {
    .setting-row {
      align-items: stretch;
      flex-direction: column;
    }
  }
</style>
