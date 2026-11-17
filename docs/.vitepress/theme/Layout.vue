<script setup>
import DefaultTheme from "vitepress/theme"
import { withBase } from "vitepress"

const { Layout } = DefaultTheme
</script>

<template>
  <Layout>
    <template #nav-bar-content-after>
      <a
        class="version-badge"
        :href="withBase('/operations/release-notes-0.1.0')"
        title="Stable documentation for Ensemble 0.1.x"
      >
        <span class="version-badge__dot" aria-hidden="true" />
        0.1.x stable
      </a>
    </template>
  </Layout>
</template>
