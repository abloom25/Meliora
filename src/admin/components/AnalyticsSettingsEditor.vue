<script setup lang="ts">
  import { ChevronDown } from '@lucide/vue'
  import { computed, ref } from 'vue'
  import type { MusicConfig } from '../../types/music'
  import ToggleSwitch from '../../components/ToggleSwitch.vue'
  import Collapse from '../../components/Collapse.vue'
  import BaseInput from '../../components/BaseInput.vue'

  const props = defineProps<{ config: MusicConfig }>()
  const emit = defineEmits<{ 'update:config': [value: MusicConfig] }>()
  const umamiExpanded = ref(true)
  const googleExpanded = ref(true)

  function updateUmami(
    patch: Partial<NonNullable<MusicConfig['umami']>>,
    stringKey?: 'scriptUrl' | 'websiteId',
  ) {
    const nextUmami = { ...props.config.umami, ...patch }
    if (stringKey && !String(nextUmami[stringKey] || '').trim()) {
      delete nextUmami[stringKey]
    }

    const next = { ...props.config }
    if (nextUmami.enabled || nextUmami.scriptUrl || nextUmami.websiteId) {
      next.umami = nextUmami
    } else {
      delete next.umami
    }
    emit('update:config', next)
  }

  function updateGoogleAnalytics(
    patch: Partial<NonNullable<MusicConfig['googleAnalytics']>>,
    stringKey?: 'measurementId',
  ) {
    const nextGoogleAnalytics = { ...props.config.googleAnalytics, ...patch }
    if (stringKey && !String(nextGoogleAnalytics[stringKey] || '').trim()) {
      delete nextGoogleAnalytics[stringKey]
    }

    const next = { ...props.config }
    if (nextGoogleAnalytics.enabled || nextGoogleAnalytics.measurementId) {
      next.googleAnalytics = nextGoogleAnalytics
    } else {
      delete next.googleAnalytics
    }
    emit('update:config', next)
  }

  const umamiEnabled = computed({
    get: () => Boolean(props.config.umami?.enabled),
    set: (enabled: boolean) => updateUmami({ enabled }),
  })

  const umamiScriptUrl = computed({
    get: () => props.config.umami?.scriptUrl || '',
    set: (scriptUrl: string) => updateUmami({ scriptUrl }, 'scriptUrl'),
  })

  const umamiWebsiteId = computed({
    get: () => props.config.umami?.websiteId || '',
    set: (websiteId: string) => updateUmami({ websiteId }, 'websiteId'),
  })

  const googleAnalyticsEnabled = computed({
    get: () => Boolean(props.config.googleAnalytics?.enabled),
    set: (enabled: boolean) => updateGoogleAnalytics({ enabled }),
  })

  const googleMeasurementId = computed({
    get: () => props.config.googleAnalytics?.measurementId || '',
    set: (measurementId: string) => updateGoogleAnalytics({ measurementId }, 'measurementId'),
  })

  const googleSiteVerification = computed({
    get: () => props.config.googleSiteVerification || '',
    set: (googleSiteVerification: string) => {
      const next = { ...props.config }
      if (googleSiteVerification.trim()) {
        next.googleSiteVerification = googleSiteVerification
      } else {
        delete next.googleSiteVerification
      }
      emit('update:config', next)
    },
  })
</script>

<template>
  <div class="admin-section">
    <h3 class="section-title">统计</h3>

    <Collapse v-model:expanded="umamiExpanded" class="analytics-group">
      <template #trigger="{ toggle }">
        <div class="analytics-header">
          <button type="button" class="collapse-button" @click="toggle">
            <ChevronDown :size="16" :class="{ collapsed: !umamiExpanded }" />
            <span class="row-label">
              <strong>Umami</strong>
              <small>启用 Umami 访问统计</small>
            </span>
          </button>
          <ToggleSwitch v-model="umamiEnabled" />
        </div>
      </template>
      <div class="analytics-body">
        <div class="setting-row">
          <span class="row-label"><strong>Umami Script</strong></span>
          <BaseInput
            v-model="umamiScriptUrl"
            type="url"
            placeholder="https://cloud.umami.is/script.js"
          />
        </div>

        <div class="setting-row">
          <span class="row-label"><strong>Umami Website ID</strong></span>
          <BaseInput v-model="umamiWebsiteId" type="text" placeholder="xxxxxxxx-xxxx" />
        </div>
      </div>
    </Collapse>

    <Collapse v-model:expanded="googleExpanded" class="analytics-group">
      <template #trigger="{ toggle }">
        <div class="analytics-header">
          <button type="button" class="collapse-button" @click="toggle">
            <ChevronDown :size="16" :class="{ collapsed: !googleExpanded }" />
            <span class="row-label">
              <strong>Google</strong>
              <small>GA4 访问统计和 Search Console 验证</small>
            </span>
          </button>
          <ToggleSwitch v-model="googleAnalyticsEnabled" />
        </div>
      </template>
      <div class="analytics-body">
        <div class="setting-row">
          <span class="row-label"><strong>Measurement ID</strong></span>
          <BaseInput v-model="googleMeasurementId" type="text" placeholder="G-XXXXXXXXXX" />
        </div>

        <div class="setting-row">
          <span class="row-label">
            <strong>Google 站点验证</strong>
            <small>Search Console 验证码</small>
          </span>
          <BaseInput
            v-model="googleSiteVerification"
            type="text"
            placeholder="google-site-verification content"
          />
        </div>
      </div>
    </Collapse>
  </div>
</template>

<style scoped lang="scss">
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

  .analytics-group {
    border-top: 1px solid rgba(255, 255, 255, 0.075);
  }

  .analytics-header,
  .setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
  }

  .analytics-header {
    padding: 14px;
    min-width: 0;
  }

  .setting-row {
    padding: 15px 14px;
    border-top: 1px solid rgba(255, 255, 255, 0.075);
  }

  .analytics-body {
    min-height: 0;
    overflow: hidden;
    background: rgba(0, 0, 0, 0.08);
  }

  .collapse-button {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 9px;
    min-width: 0;
    padding: 0;
    border: none;
    background: transparent;
    color: rgba(255, 255, 255, 0.72);
    cursor: pointer;
    text-align: left;
    overflow: hidden;

    svg {
      flex-shrink: 0;
      transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);

      &.collapsed {
        transform: rotate(-90deg);
      }
    }

    &:hover {
      color: #fff;
    }
  }

  .row-label {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;

    strong {
      color: #fff;
      font-size: 0.86rem;
      font-weight: 560;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    small {
      color: var(--text-subtle);
      font-size: 0.7rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }

  @media (max-width: 720px) {
    .admin-section {
      border-radius: 16px;
    }

    .section-title {
      padding: 11px 12px 9px;
      font-size: 0.58rem;
    }

    .analytics-header {
      padding: 13px 12px;
    }

    .setting-row {
      align-items: stretch;
      flex-direction: column;
      gap: 10px;
      padding: 13px 12px;
    }

    .row-label {
      strong,
      small {
        white-space: normal;
      }
    }
  }
</style>
