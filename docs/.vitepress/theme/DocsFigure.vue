<script setup>
import { withBase } from "vitepress"

const props = defineProps({
  src: { type: String, required: true },
  alt: { type: String, required: true },
  caption: { type: String, required: true },
  width: { type: [String, Number], default: undefined },
  height: { type: [String, Number], default: undefined },
  loading: { type: String, default: "lazy" },
})
</script>

<template>
  <figure class="docs-figure">
    <a
      :href="withBase(props.src)"
      target="_blank"
      rel="noopener noreferrer"
      :aria-label="`Open full-size image. ${props.alt}`"
    >
      <img
        :src="withBase(props.src)"
        :alt="props.alt"
        :width="props.width"
        :height="props.height"
        :loading="props.loading"
        decoding="async"
      />
    </a>
    <figcaption>{{ props.caption }}</figcaption>
  </figure>
</template>
