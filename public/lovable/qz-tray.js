// QZ Tray JavaScript Library Loader
// This file loads the QZ Tray library from CDN
// Version: 2.2.5

(function () {
  // console.log('📦 Carregando QZ Tray do CDN...');

  // Create script element for QZ Tray
  const script = document.createElement("script");
  script.src = "https://cdn.jsdelivr.net/npm/qz-tray@2.2.5/qz-tray.min.js";
  script.async = false;

  // Add to document head
  document.head.appendChild(script);

  // Log when loaded
  script.onload = function () {
    // console.log('✅ QZ Tray library carregada com sucesso do CDN');
    // console.log('window.qz disponível:', typeof window.qz !== 'undefined');
  };

  script.onerror = function () {
    // console.error('❌ Falha ao carregar QZ Tray library do CDN');
    // console.error('URL tentada:', script.src);
  };
})();
