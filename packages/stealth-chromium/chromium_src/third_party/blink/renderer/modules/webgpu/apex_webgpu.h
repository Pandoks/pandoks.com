// apex_webgpu.h -- module-local helpers for the WebGPU persona spoof.
//
// Included only by gpu_adapter.cc / gpu_device.cc. The generic env access is
// apex_fingerprint.h; these helpers bind the spoof to the WebGPU types and
// keep every surface (adapter info, adapter/device features, adapter/device
// limits, adapter type/backend) reading the same persona values.
//
// Env contract (all optional -- unset means "use the real Chromium value"):
//   APEX_FP_WEBGPU_VENDOR        GPUAdapterInfo.vendor ("apple"/"nvidia"/...)
//   APEX_FP_WEBGPU_ARCH          GPUAdapterInfo.architecture ("common-3", ...)
//   APEX_FP_WEBGPU_DEVICE_ID     GPUAdapterInfo.device (hex device ID string)
//   APEX_FP_WEBGPU_DESCRIPTION   GPUAdapterInfo.description (device name)
//   APEX_FP_WEBGPU_DRIVER        GPUAdapterInfo.driver (backend/driver string)
//   APEX_FP_WEBGPU_TYPE          adapter type: "discrete"|"integrated"|"cpu"
//   APEX_FP_WEBGPU_BACKEND       backend: "d3d11"|"d3d12"|"metal"|"vulkan"|...
//   APEX_FP_WEBGPU_FEATURES      comma list of feature names to KEEP (subset)
//   APEX_FP_WEBGPU_LIMIT_<Name>  per-limit override (GPUSupportedLimits name)

#ifndef THIRD_PARTY_BLINK_RENDERER_MODULES_WEBGPU_APEX_WEBGPU_H_
#define THIRD_PARTY_BLINK_RENDERER_MODULES_WEBGPU_APEX_WEBGPU_H_

#include "third_party/blink/renderer/bindings/modules/v8/v8_gpu_feature_name.h"
#include "third_party/blink/renderer/modules/webgpu/apex_fingerprint.h"
#include "third_party/blink/renderer/modules/webgpu/gpu_supported_features.h"
#include "third_party/blink/renderer/modules/webgpu/gpu_supported_limits.h"
#include "third_party/blink/renderer/platform/wtf/text/wtf_string.h"
#include "third_party/blink/renderer/platform/wtf/hash_set.h"

// This header is included from gpu_adapter.cc / gpu_device.cc, which live in
// namespace blink -- but these helpers sit in namespace apex_webgpu, where
// blink names are not in scope. Import the ones the helpers use. In 157 the
// WTF namespace types (String, StringView, HashSet) were migrated into
// namespace blink, so every one of these is blink::.
namespace apex_webgpu {
using blink::GPUSupportedFeatures;
using blink::GPUSupportedLimits;
using blink::MakeGarbageCollected;
using blink::V8GPUFeatureName;
using blink::HashSet;
using blink::String;
using blink::StringView;

// Replace *out with the env value when the override is present.
inline void ApplyStringOverride(const char* env, String* out) {
  const std::string v = apex_fp::EnvStr(env);
  if (!v.empty()) {
    *out = String::FromUtf8(v);
  }
}

// Map "APEX_FP_WEBGPU_TYPE" onto the wgpu::AdapterType enum. Returns false
// (leaves *out untouched) when unset or unrecognized.
inline bool ApplyAdapterTypeOverride(wgpu::AdapterType* out) {
  const std::string v = apex_fp::EnvStr("APEX_FP_WEBGPU_TYPE");
  if (v == "discrete") {
    *out = wgpu::AdapterType::DiscreteGPU;
    return true;
  }
  if (v == "integrated") {
    *out = wgpu::AdapterType::IntegratedGPU;
    return true;
  }
  if (v == "cpu") {
    *out = wgpu::AdapterType::CPU;
    return true;
  }
  return false;
}

// Map "APEX_FP_WEBGPU_BACKEND" onto the wgpu::BackendType enum.
inline bool ApplyBackendTypeOverride(wgpu::BackendType* out) {
  const std::string v = apex_fp::EnvStr("APEX_FP_WEBGPU_BACKEND");
  if (v == "d3d11") {
    *out = wgpu::BackendType::D3D11;
    return true;
  }
  if (v == "d3d12") {
    *out = wgpu::BackendType::D3D12;
    return true;
  }
  if (v == "metal") {
    *out = wgpu::BackendType::Metal;
    return true;
  }
  if (v == "vulkan") {
    *out = wgpu::BackendType::Vulkan;
    return true;
  }
  if (v == "opengl") {
    *out = wgpu::BackendType::OpenGL;
    return true;
  }
  if (v == "opengles") {
    *out = wgpu::BackendType::OpenGLES;
    return true;
  }
  return false;
}

// Every GPUSupportedLimits attribute name (must match gpu_supported_limits.cc's
// SUPPORTED_LIMITS list). Members of ComboLimits are typed u32 or u64 exactly
// as the wgpu::Limits fields are; decltype resolves each.
#define APEX_WEBGPU_LIMIT_LIST(X)                  \
  X(maxTextureDimension1D)                         \
  X(maxTextureDimension2D)                         \
  X(maxTextureDimension3D)                         \
  X(maxTextureArrayLayers)                         \
  X(maxBindGroups)                                 \
  X(maxBindGroupsPlusVertexBuffers)                \
  X(maxBindingsPerBindGroup)                       \
  X(maxDynamicUniformBuffersPerPipelineLayout)     \
  X(maxDynamicStorageBuffersPerPipelineLayout)     \
  X(maxSampledTexturesPerShaderStage)              \
  X(maxSamplersPerShaderStage)                     \
  X(maxStorageBuffersPerShaderStage)               \
  X(maxStorageTexturesPerShaderStage)              \
  X(maxUniformBuffersPerShaderStage)               \
  X(maxUniformBufferBindingSize)                   \
  X(maxStorageBufferBindingSize)                   \
  X(minUniformBufferOffsetAlignment)               \
  X(minStorageBufferOffsetAlignment)               \
  X(maxVertexBuffers)                              \
  X(maxBufferSize)                                 \
  X(maxVertexAttributes)                           \
  X(maxVertexBufferArrayStride)                    \
  X(maxInterStageShaderVariables)                  \
  X(maxColorAttachments)                           \
  X(maxColorAttachmentBytesPerSample)              \
  X(maxComputeWorkgroupStorageSize)                \
  X(maxComputeInvocationsPerWorkgroup)             \
  X(maxComputeWorkgroupSizeX)                      \
  X(maxComputeWorkgroupSizeY)                      \
  X(maxComputeWorkgroupSizeZ)                      \
  X(maxComputeWorkgroupsPerDimension)              \
  X(maxStorageBuffersInFragmentStage)              \
  X(maxStorageTexturesInFragmentStage)             \
  X(maxStorageBuffersInVertexStage)                \
  X(maxStorageTexturesInVertexStage)               \
  X(maxImmediateSize)

// The REAL adapter type, read from the real handle. The spoof rewrites the
// reported identity (including the GPUAdapter object's adapter_type_ member)
// but never the handle, so this returns the host hardware's actual type at
// every call site.
inline wgpu::AdapterType RealAdapterType(const wgpu::Adapter& adapter) {
  wgpu::AdapterInfo info = {};
  adapter.GetInfo(&info);
  return info.adapterType;
}

// Apply APEX_FP_WEBGPU_LIMIT_<Name> overrides to the limits struct BEFORE it
// is copied into a GPUSupportedLimits. Callers: gpu_adapter.cc and
// gpu_device.cc, both immediately after GetLimits() and before the
// MakeGarbageCollected<GPUSupportedLimits>. 0 is a valid unset sentinel: no
// WebGPU limit is legitimately 0. real_adapter_type is the host adapter's
// REAL type (via RealAdapterType(), not the spoofed reported identity).
//
// Clamp rule: when the real adapter is actual hardware (discrete/integrated),
// each override is CLAMPED to the real limit -- the GPU process validates
// requests against the REAL limits, so an override above them just moves the
// rejection error into a named name (a host leak). When the real adapter is
// software (SwiftShader reports AdapterType::CPU) or undetectable (Unknown),
// there is no real hardware to validate against, so the CLAIMED value is
// reported directly: a discrete persona's limits stay coherent with its
// claimed description instead of being clamped to the container's real
// SwiftShader limits.
inline void ApplyLimitOverrides(GPUSupportedLimits::ComboLimits* limits,
                                wgpu::AdapterType real_adapter_type) {
  if (!apex_fp::Active()) {
    return;
  }
  const bool apex_has_real_hardware =
      real_adapter_type == wgpu::AdapterType::DiscreteGPU ||
      real_adapter_type == wgpu::AdapterType::IntegratedGPU;
#define APEX_LIMIT(name)                                                    \
  {                                                                         \
    const uint64_t apex_v =                                                 \
        apex_fp::EnvU64("APEX_FP_WEBGPU_LIMIT_" #name, 0);                  \
    if (apex_v != 0) {                                                      \
      using ApexLimitT =                                                    \
          decltype(GPUSupportedLimits::ComboLimits::name);                  \
      const uint64_t apex_real = static_cast<uint64_t>(limits->name);       \
      limits->name = static_cast<ApexLimitT>(                               \
          !apex_has_real_hardware || apex_v < apex_real ? apex_v            \
                                                        : apex_real);       \
    }                                                                       \
  }
  APEX_WEBGPU_LIMIT_LIST(APEX_LIMIT)
#undef APEX_LIMIT
}

// Restrict the reported feature set to APEX_FP_WEBGPU_FEATURES (comma list of
// JS feature names). Subset-only by construction: a claimed feature the real
// adapter lacks would fail requestDevice's requiredFeatures validation.
// Unset allowlist = keep the real set.
inline GPUSupportedFeatures* FilterFeaturesByAllowlist(
    GPUSupportedFeatures* features) {
  if (!features) {
    return features;
  }
  const std::string allow = apex_fp::EnvStr("APEX_FP_WEBGPU_FEATURES");
  if (!apex_fp::Active() || allow.empty()) {
    return features;
  }
  HashSet<String> apex_allow;
  size_t apex_pos = 0;
  while (true) {
    const size_t apex_comma = allow.find(',', apex_pos);
    const std::string apex_tok =
        (apex_comma == std::string::npos)
            ? allow.substr(apex_pos)
            : allow.substr(apex_pos, apex_comma - apex_pos);
    if (!apex_tok.empty()) {
      apex_allow.insert(String::FromUtf8(apex_tok));
    }
    if (apex_comma == std::string::npos) {
      break;
    }
    apex_pos = apex_comma + 1;
  }
  GPUSupportedFeatures* apex_out = MakeGarbageCollected<GPUSupportedFeatures>();
  for (unsigned apex_i = 0; apex_i < V8GPUFeatureName::kEnumSize; ++apex_i) {
    const auto apex_e = static_cast<V8GPUFeatureName::Enum>(apex_i);
    if (!features->Has(apex_e)) {
      continue;
    }
    const V8GPUFeatureName apex_v(apex_e);
    if (!apex_allow.Contains(String::FromUtf8(apex_v.AsStringView().Utf8()))) {
      continue;
    }
    apex_out->AddFeatureName(apex_v);
  }
  return apex_out;
}

}  // namespace apex_webgpu

#endif  // THIRD_PARTY_BLINK_RENDERER_MODULES_WEBGPU_APEX_WEBGPU_H_
