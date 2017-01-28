var Web3 = require("web3");
var SolidityEvent = require("web3/lib/web3/event.js");

(function() {
  // Planned for future features, logging, etc.
  function Provider(provider) {
    this.provider = provider;
  }

  Provider.prototype.send = function() {
    this.provider.send.apply(this.provider, arguments);
  };

  Provider.prototype.sendAsync = function() {
    this.provider.sendAsync.apply(this.provider, arguments);
  };

  var BigNumber = (new Web3()).toBigNumber(0).constructor;

  var Utils = {
    is_object: function(val) {
      return typeof val == "object" && !Array.isArray(val);
    },
    is_big_number: function(val) {
      if (typeof val != "object") return false;

      // Instanceof won't work because we have multiple versions of Web3.
      try {
        new BigNumber(val);
        return true;
      } catch (e) {
        return false;
      }
    },
    merge: function() {
      var merged = {};
      var args = Array.prototype.slice.call(arguments);

      for (var i = 0; i < args.length; i++) {
        var object = args[i];
        var keys = Object.keys(object);
        for (var j = 0; j < keys.length; j++) {
          var key = keys[j];
          var value = object[key];
          merged[key] = value;
        }
      }

      return merged;
    },
    promisifyFunction: function(fn, C) {
      var self = this;
      return function() {
        var instance = this;

        var args = Array.prototype.slice.call(arguments);
        var tx_params = {};
        var last_arg = args[args.length - 1];

        // It's only tx_params if it's an object and not a BigNumber.
        if (Utils.is_object(last_arg) && !Utils.is_big_number(last_arg)) {
          tx_params = args.pop();
        }

        tx_params = Utils.merge(C.class_defaults, tx_params);

        return new Promise(function(accept, reject) {
          var callback = function(error, result) {
            if (error != null) {
              reject(error);
            } else {
              accept(result);
            }
          };
          args.push(tx_params, callback);
          fn.apply(instance.contract, args);
        });
      };
    },
    synchronizeFunction: function(fn, instance, C) {
      var self = this;
      return function() {
        var args = Array.prototype.slice.call(arguments);
        var tx_params = {};
        var last_arg = args[args.length - 1];

        // It's only tx_params if it's an object and not a BigNumber.
        if (Utils.is_object(last_arg) && !Utils.is_big_number(last_arg)) {
          tx_params = args.pop();
        }

        tx_params = Utils.merge(C.class_defaults, tx_params);

        return new Promise(function(accept, reject) {

          var decodeLogs = function(logs) {
            return logs.map(function(log) {
              var logABI = C.events[log.topics[0]];

              if (logABI == null) {
                return null;
              }

              var decoder = new SolidityEvent(null, logABI, instance.address);
              return decoder.decode(log);
            }).filter(function(log) {
              return log != null;
            });
          };

          var callback = function(error, tx) {
            if (error != null) {
              reject(error);
              return;
            }

            var timeout = C.synchronization_timeout || 240000;
            var start = new Date().getTime();

            var make_attempt = function() {
              C.web3.eth.getTransactionReceipt(tx, function(err, receipt) {
                if (err) return reject(err);

                if (receipt != null) {
                  // If they've opted into next gen, return more information.
                  if (C.next_gen == true) {
                    return accept({
                      tx: tx,
                      receipt: receipt,
                      logs: decodeLogs(receipt.logs)
                    });
                  } else {
                    return accept(tx);
                  }
                }

                if (timeout > 0 && new Date().getTime() - start > timeout) {
                  return reject(new Error("Transaction " + tx + " wasn't processed in " + (timeout / 1000) + " seconds!"));
                }

                setTimeout(make_attempt, 1000);
              });
            };

            make_attempt();
          };

          args.push(tx_params, callback);
          fn.apply(self, args);
        });
      };
    }
  };

  function instantiate(instance, contract) {
    instance.contract = contract;
    var constructor = instance.constructor;

    // Provision our functions.
    for (var i = 0; i < instance.abi.length; i++) {
      var item = instance.abi[i];
      if (item.type == "function") {
        if (item.constant == true) {
          instance[item.name] = Utils.promisifyFunction(contract[item.name], constructor);
        } else {
          instance[item.name] = Utils.synchronizeFunction(contract[item.name], instance, constructor);
        }

        instance[item.name].call = Utils.promisifyFunction(contract[item.name].call, constructor);
        instance[item.name].sendTransaction = Utils.promisifyFunction(contract[item.name].sendTransaction, constructor);
        instance[item.name].request = contract[item.name].request;
        instance[item.name].estimateGas = Utils.promisifyFunction(contract[item.name].estimateGas, constructor);
      }

      if (item.type == "event") {
        instance[item.name] = contract[item.name];
      }
    }

    instance.allEvents = contract.allEvents;
    instance.address = contract.address;
    instance.transactionHash = contract.transactionHash;
  };

  // Use inheritance to create a clone of this contract,
  // and copy over contract's static functions.
  function mutate(fn) {
    var temp = function Clone() { return fn.apply(this, arguments); };

    Object.keys(fn).forEach(function(key) {
      temp[key] = fn[key];
    });

    temp.prototype = Object.create(fn.prototype);
    bootstrap(temp);
    return temp;
  };

  function bootstrap(fn) {
    fn.web3 = new Web3();
    fn.class_defaults  = fn.prototype.defaults || {};

    // Set the network iniitally to make default data available and re-use code.
    // Then remove the saved network id so the network will be auto-detected on first use.
    fn.setNetwork("default");
    fn.network_id = null;
    return fn;
  };

  // Accepts a contract object created with web3.eth.contract.
  // Optionally, if called without `new`, accepts a network_id and will
  // create a new version of the contract abstraction with that network_id set.
  function Contract() {
    if (this instanceof Contract) {
      instantiate(this, arguments[0]);
    } else {
      var C = mutate(Contract);
      var network_id = arguments.length > 0 ? arguments[0] : "default";
      C.setNetwork(network_id);
      return C;
    }
  };

  Contract.currentProvider = null;

  Contract.setProvider = function(provider) {
    var wrapped = new Provider(provider);
    this.web3.setProvider(wrapped);
    this.currentProvider = provider;
  };

  Contract.new = function() {
    if (this.currentProvider == null) {
      throw new Error("DroneNoOraclize error: Please call setProvider() first before calling new().");
    }

    var args = Array.prototype.slice.call(arguments);

    if (!this.unlinked_binary) {
      throw new Error("DroneNoOraclize error: contract binary not set. Can't deploy new instance.");
    }

    var regex = /__[^_]+_+/g;
    var unlinked_libraries = this.binary.match(regex);

    if (unlinked_libraries != null) {
      unlinked_libraries = unlinked_libraries.map(function(name) {
        // Remove underscores
        return name.replace(/_/g, "");
      }).sort().filter(function(name, index, arr) {
        // Remove duplicates
        if (index + 1 >= arr.length) {
          return true;
        }

        return name != arr[index + 1];
      }).join(", ");

      throw new Error("DroneNoOraclize contains unresolved libraries. You must deploy and link the following libraries before you can deploy a new version of DroneNoOraclize: " + unlinked_libraries);
    }

    var self = this;

    return new Promise(function(accept, reject) {
      var contract_class = self.web3.eth.contract(self.abi);
      var tx_params = {};
      var last_arg = args[args.length - 1];

      // It's only tx_params if it's an object and not a BigNumber.
      if (Utils.is_object(last_arg) && !Utils.is_big_number(last_arg)) {
        tx_params = args.pop();
      }

      tx_params = Utils.merge(self.class_defaults, tx_params);

      if (tx_params.data == null) {
        tx_params.data = self.binary;
      }

      // web3 0.9.0 and above calls new twice this callback twice.
      // Why, I have no idea...
      var intermediary = function(err, web3_instance) {
        if (err != null) {
          reject(err);
          return;
        }

        if (err == null && web3_instance != null && web3_instance.address != null) {
          accept(new self(web3_instance));
        }
      };

      args.push(tx_params, intermediary);
      contract_class.new.apply(contract_class, args);
    });
  };

  Contract.at = function(address) {
    if (address == null || typeof address != "string" || address.length != 42) {
      throw new Error("Invalid address passed to DroneNoOraclize.at(): " + address);
    }

    var contract_class = this.web3.eth.contract(this.abi);
    var contract = contract_class.at(address);

    return new this(contract);
  };

  Contract.deployed = function() {
    if (!this.address) {
      throw new Error("Cannot find deployed address: DroneNoOraclize not deployed or address not set.");
    }

    return this.at(this.address);
  };

  Contract.defaults = function(class_defaults) {
    if (this.class_defaults == null) {
      this.class_defaults = {};
    }

    if (class_defaults == null) {
      class_defaults = {};
    }

    var self = this;
    Object.keys(class_defaults).forEach(function(key) {
      var value = class_defaults[key];
      self.class_defaults[key] = value;
    });

    return this.class_defaults;
  };

  Contract.extend = function() {
    var args = Array.prototype.slice.call(arguments);

    for (var i = 0; i < arguments.length; i++) {
      var object = arguments[i];
      var keys = Object.keys(object);
      for (var j = 0; j < keys.length; j++) {
        var key = keys[j];
        var value = object[key];
        this.prototype[key] = value;
      }
    }
  };

  Contract.all_networks = {
  "default": {
    "abi": [
      {
        "constant": false,
        "inputs": [
          {
            "name": "_newDroneStation",
            "type": "address"
          }
        ],
        "name": "changeDroneStation",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "currentDestination",
        "outputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_windSpeed",
            "type": "uint256"
          }
        ],
        "name": "requestFlight",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_droneStation",
            "type": "address"
          },
          {
            "name": "_allowed",
            "type": "address"
          },
          {
            "name": "_APIURL",
            "type": "string"
          }
        ],
        "name": "Drone",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "APIURL",
        "outputs": [
          {
            "name": "",
            "type": "string"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "droneStation",
        "outputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_to",
            "type": "address"
          }
        ],
        "name": "requestFlightOwner",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_newAPIURL",
            "type": "string"
          }
        ],
        "name": "changeAPIURL",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "owner",
        "outputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_newAllowed",
            "type": "address"
          }
        ],
        "name": "changeAllowed",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_uploadedTo",
            "type": "string"
          }
        ],
        "name": "resetState",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [],
        "name": "resetStateOwner",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "to",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "acceptedOrNot",
            "type": "string"
          }
        ],
        "name": "flightRequest",
        "type": "event"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "to",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "uploadedTo",
            "type": "string"
          }
        ],
        "name": "flightLog",
        "type": "event"
      }
    ],
    "unlinked_binary": "0x606060405260008054600160a060020a03191633600160a060020a031617905534610000575b610a65806100346000396000f3006060604052361561009e5763ffffffff60e060020a60003504166306102d8281146100a357806306c81cc4146100be5780631dd8bbd2146100e75780633a24558e146100f95780634ac4eb701461016157806357d98ff4146101ee5780635d225ff4146102175780637fa38734146102325780638da5cb5b14610287578063a1a06952146102b0578063dea02691146102cb578063e9b3a50714610320575b610000565b34610000576100bc600160a060020a036004351661032f565b005b34610000576100cb61036a565b60408051600160a060020a039092168252519081900360200190f35b34610000576100bc600435610379565b005b3461000057604080516020600460443581810135601f81018490048402850184019095528484526100bc948235600160a060020a039081169560248035909216956064949193929091019190819084018382808284375094965061053295505050505050565b005b346100005761016e61062f565b6040805160208082528351818301528351919283929083019185019080838382156101b4575b8051825260208311156101b457601f199092019160209182019101610194565b505050905090810190601f1680156101e05780820380516001836020036101000a031916815260200191505b509250505060405180910390f35b34610000576100cb6106bd565b60408051600160a060020a039092168252519081900360200190f35b34610000576100bc600160a060020a03600435166106cc565b005b34610000576100bc600480803590602001908201803590602001908080601f016020809104026020016040519081016040528093929190818152602001838380828437509496506107a595505050505050565b005b34610000576100cb610861565b60408051600160a060020a039092168252519081900360200190f35b34610000576100bc600160a060020a0360043516610870565b005b34610000576100bc600480803590602001908201803590602001908080601f016020809104026020016040519081016040528093929190818152602001838380828437509496506108ab95505050505050565b005b34610000576100bc610998565b005b60005433600160a060020a0390811691161461034a57610000565b60018054600160a060020a031916600160a060020a0383161790555b5b50565b600354600160a060020a031681565b600354600160a060020a03161561038f57610000565b6002546040805160006020918201819052825160e060020a63babcc539028152600160a060020a0333811660048301529351939094169363babcc539936024808301949391928390030190829087803b156100005760325a03f115610000575050604051516005805460ff1916911515919091179081905560ff161515905061041757610000565b60328111156104a35760035460408051600160a060020a039092168252602082018190526007828201527f72656675736564000000000000000000000000000000000000000000000000006060830152517fbd773aecdeb2262b1315e8bfb356b71bc09fa71ebb507fb2431a46b459f3c4469181900360800190a160038054600160a060020a03191690555b60038054600160a060020a03338116600160a060020a0319909216919091179182905560408051929091168252602082018190526008828201527f61636365707465640000000000000000000000000000000000000000000000006060830152517fbd773aecdeb2262b1315e8bfb356b71bc09fa71ebb507fb2431a46b459f3c4469181900360800190a15b50565b60018054600160a060020a03808616600160a060020a03199283161783556002805491861691909216178155825160048054600082905290936020601f9183161561010002600019019092169390930483018190047f8a35acfbc15ff81a39ae7d344fd709f28e8600b4aa8c65c6b64bfe7fe36bd19b9081019390918601908390106105c957805160ff19168380011785556105f6565b828001600101855582156105f6579182015b828111156105f65782518255916020019190600101906105db565b5b506106179291505b8082111561061357600081556001016105ff565b5090565b505060038054600160a060020a03191690555b505050565b6004805460408051602060026001851615610100026000190190941693909304601f810184900484028201840190925281815292918301828280156106b55780601f1061068a576101008083540402835291602001916106b5565b820191906000526020600020905b81548152906001019060200180831161069857829003601f168201915b505050505081565b600154600160a060020a031681565b60005433600160a060020a039081169116146106e757610000565b600354600160a060020a0316156106fd57610000565b6002546040805160006020918201819052825160e060020a63babcc539028152600160a060020a0386811660048301529351939094169363babcc539936024808301949391928390030190829087803b156100005760325a03f115610000575050604051516005805460ff1916911515919091179081905560ff161515905061078557610000565b60038054600160a060020a031916600160a060020a0383161790555b5b50565b60005433600160a060020a039081169116146107c057610000565b8060049080519060200190828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f1061080c57805160ff1916838001178555610839565b82800160010185558215610839579182015b8281111561083957825182559160200191906001019061081e565b5b5061062a9291505b8082111561061357600081556001016105ff565b5090565b50505b5b50565b600054600160a060020a031681565b60005433600160a060020a0390811691161461088b57610000565b60028054600160a060020a031916600160a060020a0383161790555b5b50565b60015433600160a060020a039081169116146108c657610000565b60035460408051600160a060020a03909216808352602080840183815285519385019390935284517f5bfb828d47f71f756d57f79e394f9d67bbcd5dee4a8230643154ea90cc148e0b949293869392909160608401918501908083838215610949575b80518252602083111561094957601f199092019160209182019101610929565b505050905090810190601f1680156109755780820380516001836020036101000a031916815260200191505b50935050505060405180910390a160038054600160a060020a03191690555b5b50565b60005433600160a060020a039081169116146109b357610000565b60035460408051600160a060020a039092168252602082018190526016828201527f73746174652072657365746564206279206f776e6572000000000000000000006060830152517f5bfb828d47f71f756d57f79e394f9d67bbcd5dee4a8230643154ea90cc148e0b9181900360800190a160038054600160a060020a03191690555b5b5600a165627a7a72305820e3ca14a109bbe66946ee7208770d9a589ff96f3ff58bec105c09a28a8d2508730029",
    "events": {
      "0xbd773aecdeb2262b1315e8bfb356b71bc09fa71ebb507fb2431a46b459f3c446": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "to",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "acceptedOrNot",
            "type": "string"
          }
        ],
        "name": "flightRequest",
        "type": "event"
      },
      "0x5bfb828d47f71f756d57f79e394f9d67bbcd5dee4a8230643154ea90cc148e0b": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "to",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "uploadedTo",
            "type": "string"
          }
        ],
        "name": "flightLog",
        "type": "event"
      }
    },
    "updated_at": 1485614034701,
    "links": {},
    "address": "0xbed849aa7588b52b81685ce8626df27dc4f406bf"
  }
};

  Contract.checkNetwork = function(callback) {
    var self = this;

    if (this.network_id != null) {
      return callback();
    }

    this.web3.version.network(function(err, result) {
      if (err) return callback(err);

      var network_id = result.toString();

      // If we have the main network,
      if (network_id == "1") {
        var possible_ids = ["1", "live", "default"];

        for (var i = 0; i < possible_ids.length; i++) {
          var id = possible_ids[i];
          if (Contract.all_networks[id] != null) {
            network_id = id;
            break;
          }
        }
      }

      if (self.all_networks[network_id] == null) {
        return callback(new Error(self.name + " error: Can't find artifacts for network id '" + network_id + "'"));
      }

      self.setNetwork(network_id);
      callback();
    })
  };

  Contract.setNetwork = function(network_id) {
    var network = this.all_networks[network_id] || {};

    this.abi             = this.prototype.abi             = network.abi;
    this.unlinked_binary = this.prototype.unlinked_binary = network.unlinked_binary;
    this.address         = this.prototype.address         = network.address;
    this.updated_at      = this.prototype.updated_at      = network.updated_at;
    this.links           = this.prototype.links           = network.links || {};
    this.events          = this.prototype.events          = network.events || {};

    this.network_id = network_id;
  };

  Contract.networks = function() {
    return Object.keys(this.all_networks);
  };

  Contract.link = function(name, address) {
    if (typeof name == "function") {
      var contract = name;

      if (contract.address == null) {
        throw new Error("Cannot link contract without an address.");
      }

      Contract.link(contract.contract_name, contract.address);

      // Merge events so this contract knows about library's events
      Object.keys(contract.events).forEach(function(topic) {
        Contract.events[topic] = contract.events[topic];
      });

      return;
    }

    if (typeof name == "object") {
      var obj = name;
      Object.keys(obj).forEach(function(name) {
        var a = obj[name];
        Contract.link(name, a);
      });
      return;
    }

    Contract.links[name] = address;
  };

  Contract.contract_name   = Contract.prototype.contract_name   = "DroneNoOraclize";
  Contract.generated_with  = Contract.prototype.generated_with  = "3.2.0";

  // Allow people to opt-in to breaking changes now.
  Contract.next_gen = false;

  var properties = {
    binary: function() {
      var binary = Contract.unlinked_binary;

      Object.keys(Contract.links).forEach(function(library_name) {
        var library_address = Contract.links[library_name];
        var regex = new RegExp("__" + library_name + "_*", "g");

        binary = binary.replace(regex, library_address.replace("0x", ""));
      });

      return binary;
    }
  };

  Object.keys(properties).forEach(function(key) {
    var getter = properties[key];

    var definition = {};
    definition.enumerable = true;
    definition.configurable = false;
    definition.get = getter;

    Object.defineProperty(Contract, key, definition);
    Object.defineProperty(Contract.prototype, key, definition);
  });

  bootstrap(Contract);

  if (typeof module != "undefined" && typeof module.exports != "undefined") {
    module.exports = Contract;
  } else {
    // There will only be one version of this contract in the browser,
    // and we can use that.
    window.DroneNoOraclize = Contract;
  }
})();
