const express = require("express")
const request = require("request")
const bodyParser = require("body-parser")

const PORT = 3131

var requested = false;

const app = express()
app.use(bodyParser.json())

function current(req, res) {
	if (requested) {
		return res.send("already requested")
	}
	switch (req.body.value < 0.2) {
		case true:
			{
				requested = true;
				return res.send("send drone")
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

// send a new value every second
setInterval(() => {
	request.post({
  uri: "http://localhost:" + PORT + "/current",
  method: 'POST',
  json: {value: Math.random()}
}, (e, r, b) => {console.log(b)})
}, 1000)

