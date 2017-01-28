const express = require("express")
const request = require("request")
const bodyParser = require("body-parser")
const Drone = require('./Drone.sol.js')

const PORT = 3131
const ETH_URL = "http://localhost:8545"

const Web3 = require("web3")
const web3 = new Web3(new Web3.providers.HttpProvider(ETH_URL))

const METER_ADDRESS = web3.eth.accounts[3]

Drone.setProvider(web3.currentProvider)

var d = Drone.at("0xf5Fe6d14876Ee366420fFc6cb597dfbc5E2dd1D5")

var requested = false;

const app = express()
app.use(bodyParser.json())

function current(req, res) {
	if (requested) {
		return res.send("already")
	}
	switch (req.body.value < 1) {
		case true:
			{
				return d.requestFlight(49, {from: METER_ADDRESS}).then(result => {
					console.log("hey")
					requested = true;
					return res.send("drone request sent")
				}).catch(err => {
					console.log(err)
					return res.send("Error")
				})
				break;
			}
		default:
			{
				return res.send(":rocket:")
			}
	}
}

app.post('/current', current)

app.listen(PORT, () => {
	console.log("Meter started!")
})

// send a new value every second
setInterval(() => {
	request.post({
  uri: "http://localhost:" + PORT + "/current",
  method: 'POST',
  json: {value: Math.random()}
}, (e, r, b) => {if(b !== "already") console.log(b)})
}, 1000)

