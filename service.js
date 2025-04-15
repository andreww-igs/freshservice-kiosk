var Service = require('node-windows').Service;

// Create a new service object
var svc = new Service({
  name:'ICT Kiosk',
  description: 'Simple app to allow ICT staff to lodge tickets from iMac at front counter.',
  script: 'C:\\kiosk\\server.js'
});

// Listen for the "install" event, which indicates the
// process is available as a service.
svc.on('install',function(){
  svc.start();
});

svc.install();
// svc.uninstall();