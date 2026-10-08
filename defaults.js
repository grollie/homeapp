// Starting device list for setup.html. Edit addresses there, not here.
// embed:false = the site refuses to load inside another page, so it opens in a new tab.
// app:true   = no web portal exists; the tile just links to the vendor site.
window.HH_DEFAULT_DEVICES = [
  { icon: '☀️', name: 'Solar Assistant 1', sub: 'Inverter monitor', url: 'http://solar-assistant-1.local', group: 'Power' },
  { icon: '☀️', name: 'Solar Assistant 2', sub: 'Inverter monitor', url: 'http://solar-assistant-2.local', group: 'Power' },
  { icon: '🔋', name: 'Batteries (8)', sub: 'Smart Life', url: 'https://ipc.ismartlife.me/', group: 'Power', embed: false,
    note: 'The 8 batteries are managed in the Smart Life app. This is the Smart Life web login.' },
  { icon: '🛰️', name: 'Starlink', sub: 'Dish & account', url: 'http://192.168.100.1', group: 'Network', embed: false,
    note: 'Dish status page on the local network. Account/billing: https://www.starlink.com/account' },
  { icon: '🌡️', name: 'Ecobee', sub: 'Thermostat', url: 'https://www.ecobee.com/consumerportal/index.html', group: 'Home', embed: false },
  { icon: '🏠', name: 'Nest', sub: 'Google Home', url: 'https://home.nest.com', group: 'Home', embed: false },
  { icon: '🚪', name: 'Garage Doors', sub: 'myQ', url: 'https://www.myq.com', group: 'Home', app: true,
    note: 'myQ garage doors are app-only. Open the myQ app on your phone.' },
  { icon: '🔥', name: 'First Alert', sub: 'Smoke / CO', url: 'https://www.firstalert.com', group: 'Home', app: true,
    note: 'First Alert alarms are app-only (Onelink or Google Home app).' },
  { icon: '📹', name: 'FortiRecorder', sub: 'Local NVR', url: 'https://192.168.1.2', group: 'Cameras' },
  { icon: '☁️', name: 'FortiCamera Cloud', sub: 'FortiCloud', url: 'https://forticamera.forticloud.com', group: 'Cameras', embed: false },
  { icon: '💧', name: 'Rachio', sub: 'Sprinklers', url: 'https://app.rach.io', group: 'Yard', embed: false },
  { icon: '🐈', name: 'Whisker', sub: 'Litter-Robot', url: 'https://www.whisker.com', group: 'Robots', app: true,
    note: 'Litter-Robot is app-only. Open the Whisker app on your phone.' },
  { icon: '🤖', name: 'Matic', sub: 'Robot vacuum', url: 'https://maticrobots.com', group: 'Robots', app: true,
    note: 'Matic is app-only. Open the Matic app on your phone.' },
];
