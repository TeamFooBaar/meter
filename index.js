const express = require("express")
const request = require("request")
const bodyParser = require("body-parser")
const DroneNoOraclize = require('./DroneNoOraclize.sol.js')

const PORT = 3131
const ETH_URL = "http://localhost:8545"
const GROUND_CONTRACT_ADDRESS = ""

const Web3 = require("web3")
const web3 = new Web3(new Web3.providers.HttpProvider(ETH_URL))

const METER_ADDRESS = web3.eth.accounts[1]

DroneNoOraclize.setProvider(web3.currentProvider)

var d = DroneNoOraclize.deployed()

var requested = false;

const app = express()
app.use(bodyParser.json())

function current(req, res) {
	if (requested) {
		return res.send("already")
	}
	switch (req.body.value < 2) {
		case true:
			{
				return d.requestFlight(49, {from: METER_ADDRESS}).then(result => {
					console.log("hey")
					requested = true;
					return res.send("drone request sent")
				}).catch(err => {
					return res.send("damn..")
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

function requestDrone() {
	return 
}

// send a new value every second
setInterval(() => {
	request.post({
  uri: "http://localhost:" + PORT + "/current",
  method: 'POST',
  json: {value: Math.random()}
}, (e, r, b) => {if(b !== "already") console.log(b)})
}, 1000)

