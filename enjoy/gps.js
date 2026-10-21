(function (root) {
  "use strict";
  if (root.EnjoyDemo) {
    root.EnjoyGPS = {
      start() {},
      stop() {},
      get() {
        return { state: "Demostración · GPS desactivado", fix: null };
      },
    };
    return;
  }
  let watch = null,
    last = null,
    state = "Sin iniciar",
    lastRecorded = 0;
  root.EnjoyGPS = {
    stop() {
      if (watch !== null) navigator.geolocation?.clearWatch(watch);
      watch = null;
      state = "Pausado";
    },
    get() {
      const age = last
        ? Date.now() - new Date(last.acquired_at).getTime()
        : null;
      return {
        state,
        fix: age !== null && age <= 120000 ? last : null,
        last_fix: last,
        age_ms: age,
      };
    },
  };
  // Keep acquisition non-blocking; browser visibility rules govern background updates.
  root.EnjoyGPS.start = function (onUpdate) {
    if (watch !== null) return;
    if (!navigator.geolocation) {
      state = "No disponible";
      return;
    }
    state = "Solicitando ubicación";
    watch = navigator.geolocation.watchPosition(
      (p) => {
        last = {
          latitude: p.coords.latitude,
          longitude: p.coords.longitude,
          accuracy: p.coords.accuracy,
          acquired_at: new Date(p.timestamp).toISOString(),
        };
        state = "Disponible";
        if (Date.now() - lastRecorded > 60000) {
          lastRecorded = Date.now();
          onUpdate?.(last);
        }
      },
      (e) => {
        state =
          e.code === 1 ? "Permiso no concedido" : "Ubicación no disponible";
      },
      { enableHighAccuracy: true, maximumAge: 60000, timeout: 15000 },
    );
  };
})(window);
