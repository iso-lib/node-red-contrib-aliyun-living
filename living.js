const iot = require('alibabacloud-iot-device-sdk');
const QRCode = require('qrcode');
module.exports = function (RED) {
	function living(config) {
		RED.nodes.createNode(this, config);
		var node = this;
		var param = {
			"ProductKey": config.ProductKey,
			"DeviceName": config.DeviceName,
			"DeviceSecret": config.DeviceSecret
		};
		const device=iot.device(param);
		node.on('input', function (msg) {
			device.postProps(msg.payload, (res) => {
				node.send(msg);
			});
		});
		
		node.on("close", function() {
            RED.comms.publish("qrdata", { id:this.id });
            node.status({});
			device.end();
        });
		
		device.onProps((res)=>{
			node.send({payload:res.params});
		});

		device.on('error', (err) => {
			node.status({fill:"red",shape:"ring",text:"连接错误"});
			device.end();
		});

		device.on('connect', function (msg) {
			node.status({fill:"green",shape:"ring",text:"已连接"});
			qrdraw(msg);
		});
		function qrdraw(msg) {
			var qrurl = "https://g.aliplus.com/ilop/d.html?locale=all&pk=" + param.ProductKey + "&dn=" + param.DeviceName;
				QRCode.toDataURL(qrurl, function (err, data) {
				var qrdata = data.replace('data:image/png;base64,','');
			if (qrdata !== null) { var deviceQR = { id:node.id,data:qrdata }}
			try {
					RED.comms.publish("qrdata", deviceQR);
					if (msg.hasOwnProperty("filename")) { node.status({text:" " + msg.filename}); }
				}
				catch(e) {
					node.error("Wrong qrdata!!", msg);
				}
			})
		}
	}
	RED.nodes.registerType("aliyun-living", living);
}


