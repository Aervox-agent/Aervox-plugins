const message = document.getElementById('message');
async function loadConfig() {
  await window.AervoxPluginPageBridge.ready();
  const config = await window.AervoxPluginPageBridge.getConfig();
  message.textContent = String(config.values.message ?? '');
}
loadConfig().catch(() => { message.textContent = '读取失败，请在宿主检查插件状态与授权'; });
