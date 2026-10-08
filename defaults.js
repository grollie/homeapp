// Starting device list for setup.html. Edit addresses there, not here.
// embed:false = the site refuses to load inside another page, so it opens in a new tab.
// app:true   = no web portal exists; the tile just links to the vendor site.
window.HH_DEFAULT_DEVICES = [
  // Live merged view of every Solar Assistant on the account, via relay/worker.js.
  // In setup, put the worker URL in "solarRelay" and the RELAY_KEY in the API key field.
  { icon: '☀️', name: 'Solar Assistant', sub: 'Both systems · live', url: 'https://3rd-rail.us.solar-assistant.io/', group: 'Power',
    solarRelay: 'https://solar-relay.garyrollie.workers.dev' },
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
  { icon: '📹', name: 'FortiRecorder 1', sub: '10.250.1.47', url: 'https://10.250.1.47', group: 'Cameras' },
  { icon: '📹', name: 'FortiRecorder 2', sub: '10.250.1.48', url: 'https://10.250.1.48', group: 'Cameras' },
  { icon: '☁️', name: 'FortiCamera Cloud', sub: 'FortiCloud', url: 'https://forticamera.forticloud.com', group: 'Cameras', embed: false },
  { icon: '💧', name: 'Rachio', sub: 'Sprinklers', url: 'https://app.rach.io', group: 'Yard', embed: false },
  { icon: '🐈', name: 'Litter-Robot', sub: 'Whisker', url: 'https://www.whisker.com', group: 'Robots', app: true,
    note: 'Litter-Robot is app-only. Open the Whisker app on your phone.' },
  { icon: '🍽️', name: 'Feeder-Robot', sub: 'Whisker', url: 'https://www.whisker.com', group: 'Robots', app: true,
    note: 'Feeder-Robot is app-only. Open the Whisker app on your phone.' },
  { icon: '🤖', name: 'Matic', sub: 'Robot vacuum', url: 'https://maticrobots.com', group: 'Robots', app: true,
    note: 'Matic is app-only. Open the Matic app on your phone.' },
  { icon: '🔑', name: 'Google Password Manager', sub: 'All device logins', url: 'https://passwords.google.com/', group: 'Accounts', embed: false,
    note: 'Every device login is saved in Google Password Manager. Chrome fills them in automatically when you open a device; use this to look one up or share it with the family.' },
];
