const express = require("express")
const request = require("request")
const bodyParser = require("body-parser")

const PORT = 3131
const ETH_URL = "http://localhost:8545"
const GROUND_CONTRACT_ADDRESS = ""
const METER_ADDRESS = "0xcc30608bff4b93e46e08d9f141046f38b8005ece"

const Web3 = require("web3")
const web3 = new Web3(new Web3.providers.HttpProvider(ETH_URL))

var requested = false;

const app = express()
app.use(bodyParser.json())

function current(req, res) {
	if (requested) {
		return res.send("already")
	}
	switch (req.body.value < 0.3) {
		case true:
			{
				requestDrone((err, result) => {
					if(err) return res.send("drone request failed")
					requested = true;
					return res.send("drone request sent")
				})
				break;
			}
		default:
			{
				return res.send("all good man")
			}
	}
}

app.post('/current', current)

app.listen(PORT, () => {
	console.log("Meter started!")
})

function requestDrone(cb) {
	web3.eth.sendTransaction({from: METER_ADDRESS, to: METER_ADDRESS, value: 1, gas: 30000}, (err,res) => {
		console.log(res)
		console.log(err, res)
		return cb(err, res);
	})
}

// send a new value every second
setInterval(() => {
	request.post({
  uri: "http://localhost:" + PORT + "/current",
  method: 'POST',
  json: {value: Math.random()}
}, (e, r, b) => {if(b !== "already") console.log(b)})
}, 1000)

