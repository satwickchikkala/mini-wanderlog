// public/scripts/map.js
let map;
let markers = [];

export function noop(){}

window.initMap = function() {
  try {
    map = new google.maps.Map(document.getElementById('map'), {
      center: { lat: 20.5937, lng: 78.9629 },
      zoom: 4
    });
  } catch(e) {
    console.warn('Google maps failed to load', e);
  }
};

// fallback initializer if Google Maps script not present
function initFallbackMap() {
  const el = document.getElementById('map');
  if (!el) return;
  el.innerHTML = '<div style="padding:24px;text-align:center;color:#777;">Map unavailable (no Google Maps API key). Generated places will show as a list.</div>';
}

window.addMarkers = function(points) {
  if (!points || !points.length) return;
  // If google maps is available, place markers; else do nothing (we show list elsewhere).
  if (typeof google !== 'undefined' && map) {
    // clear old markers
    markers.forEach(m => m.setMap(null));
    markers = [];
    points.forEach(p => {
      if (p.lat && p.lon) {
        const m = new google.maps.Marker({
          map,
          position: { lat: p.lat, lng: p.lon },
          title: p.name
        });
        markers.push(m);
      }
    });
    if (markers.length) {
      map.setCenter(markers[0].getPosition());
      map.setZoom(12);
    }
  } else {
    // fallback: ensure we at least show a placeholder
    initFallbackMap();
  }
};

// if initMap never called (no google script), initialize fallback
window.addEventListener('load', () => {
  if (typeof google === 'undefined') initFallbackMap();
});
