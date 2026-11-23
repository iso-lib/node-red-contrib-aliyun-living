const iot = require('alibabacloud-iot-device-sdk');
const QRCode = require('qrcode');
module.exports = function (RED) {
	function living(config) {
		RED.nodes.createNode(this, config);
		var node = this;
		var param = {
			"ProductKey": config.ProductKey,
			"DeviceName": config.DeviceName,
			// 注意：DeviceSecret 刻意保留在普通配置 (defaults) 中，不迁入
			// Node-RED credentials。老用户升级后无需重填；三元组原申请页
			// https://iot.aliyun.com/products/livinglink 经 2026-11-23
			// 核实已无法访问（页面已删除/下线），丢了密钥无法重申请，
			// 迁移会让老设备直接断连。
			"DeviceSecret": config.DeviceSecret
		};

		var device = null;
		var closing = false;
		var connected = false;
		var reconnectTimer = null;
		var reconnectDelay = 1000;
		var RECONNECT_MAX_DELAY = 30000;

		if (!param.ProductKey || !param.DeviceName || !param.DeviceSecret) {
			node.status({ fill: "red", shape: "ring", text: "缺少三元组" });
			node.error("aliyun-living: ProductKey / DeviceName / DeviceSecret 未配全，设备未连接");
			return;
		}

		function clearReconnectTimer() {
			if (reconnectTimer) {
				clearTimeout(reconnectTimer);
				reconnectTimer = null;
			}
		}

		function scheduleReconnect(reason) {
			if (closing) { return; }
			connected = false;
			clearReconnectTimer();
			var delaySec = Math.round(reconnectDelay / 1000);
			node.status({ fill: "yellow", shape: "ring", text: "重连中 " + delaySec + "s" });
			node.warn("aliyun-living: " + (reason || "连接断开") + "，" + delaySec + " 秒后重连");
			reconnectTimer = setTimeout(function () {
				reconnectTimer = null;
				reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY);
				createDevice();
			}, reconnectDelay);
		}

		function endDeviceQuietly() {
			if (!device) { return; }
			var old = device;
			device = null;
			try {
				if (typeof old.end === "function") { old.end(); }
			} catch (e) {
				node.warn("aliyun-living: 关闭旧连接失败: " + (e && e.message ? e.message : e));
			}
		}

		function createDevice() {
			if (closing) { return; }
			clearReconnectTimer();
			var dev;
			try {
				// alibabacloud-iot-device-sdk 没有自动重连，也没有提供重连
				// 方法（上游 Issue #13），断线只能重新 iot.device() 建新实例。
				dev = iot.device(param);
			} catch (e) {
				node.error("aliyun-living: 创建设备失败: " + (e && e.message ? e.message : e));
				scheduleReconnect("创建设备失败");
				return;
			}
			device = dev;

			dev.onProps(function (res) {
				if (!res || typeof res !== "object" || !res.params || typeof res.params !== "object") {
					node.warn("aliyun-living: 收到无 params 的下行消息，已忽略");
					return;
				}
				node.send({ payload: res.params });
			});

			dev.on("error", function (err) {
				var msg = err && err.message ? err.message : String(err || "未知错误");
				node.status({ fill: "red", shape: "ring", text: "连接错误" });
				node.error("aliyun-living: 连接错误: " + msg);
				endDeviceQuietly();
				scheduleReconnect("连接错误: " + msg);
			});

			// SDK 底层是 MQTT，断线时可能只发 offline 不发 error，两种都接上。
			if (typeof dev.on === "function") {
				dev.on("offline", function () {
					if (closing || !device) { return; }
					endDeviceQuietly();
					scheduleReconnect("设备离线");
				});
			}

			dev.on("connect", function (msg) {
				connected = true;
				reconnectDelay = 1000;
				node.status({ fill: "green", shape: "ring", text: "已连接" });
				qrdraw(msg);
			});
		}

		function qrdraw(msg) {
			var qrurl = "https://g.aliplus.com/ilop/d.html?locale=all&pk=" + param.ProductKey + "&dn=" + param.DeviceName;
			QRCode.toDataURL(qrurl, function (err, data) {
				if (err) {
					node.error("aliyun-living: 生成二维码失败: " + (err.message || err));
					return;
				}
				if (!data || typeof data !== "string") {
					node.error("aliyun-living: 生成二维码失败: 返回为空");
					return;
				}
				var qrdata = data.replace("data:image/png;base64,", "");
				if (!qrdata) {
					node.error("aliyun-living: 生成二维码失败: 数据为空");
					return;
				}
				try {
					RED.comms.publish("qrdata", { id: node.id, data: qrdata });
					// connect 事件的 msg 不一定是对象/不一定带 filename，先判型再取。
					if (msg && typeof msg === "object" && typeof msg.filename === "string") {
						node.status({ text: " " + msg.filename });
					}
				} catch (e) {
					node.error("aliyun-living: 推送二维码失败: " + (e && e.message ? e.message : e), msg);
				}
			});
		}

		node.on("input", function (msg, send, done) {
			var doSend = typeof send === "function" ? send : node.send.bind(node);
			var finish = typeof done === "function" ? done : function (err) {
				if (err) { node.error(err, msg); }
			};
			if (!msg || !msg.payload || typeof msg.payload !== "object" || Array.isArray(msg.payload)) {
				finish(new Error("aliyun-living: msg.payload 须为物模型属性对象"));
				return;
			}
			if (!device || !connected) {
				finish(new Error("aliyun-living: 设备未连接，上报已丢弃"));
				return;
			}
			try {
				device.postProps(msg.payload, function (res) {
					// postProps 回调只带结果对象；只有明确返回非 200 才算失败，
					// 其余情况沿用原行为：上报成功后把原消息往下传。
					if (res && typeof res === "object" && typeof res.code === "number" && res.code !== 200) {
						finish(new Error("aliyun-living: 上报失败 code=" + res.code));
						return;
					}
					doSend(msg);
					finish();
				});
			} catch (e) {
				finish(e instanceof Error ? e : new Error("aliyun-living: 上报异常: " + e));
			}
		});

		node.on("close", function (removed, done) {
			// close 可能以 (done) / (removed, done) / () 三种签名被调。
			var finish = typeof done === "function" ? done
				: (typeof removed === "function" ? removed : null);
			closing = true;
			clearReconnectTimer();
			connected = false;
			try {
				RED.comms.publish("qrdata", { id: node.id });
			} catch (e) {
				// 编辑器已断开时推送失败不影响关闭
			}
			node.status({});
			endDeviceQuietly();
			if (finish) { finish(); }
		});

		createDevice();
	}
	RED.nodes.registerType("aliyun-living", living);
}
