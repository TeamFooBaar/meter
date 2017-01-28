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
      throw new Error("Drone error: Please call setProvider() first before calling new().");
    }

    var args = Array.prototype.slice.call(arguments);

    if (!this.unlinked_binary) {
      throw new Error("Drone error: contract binary not set. Can't deploy new instance.");
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

      throw new Error("Drone contains unresolved libraries. You must deploy and link the following libraries before you can deploy a new version of Drone: " + unlinked_libraries);
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
      throw new Error("Invalid address passed to Drone.at(): " + address);
    }

    var contract_class = this.web3.eth.contract(this.abi);
    var contract = contract_class.at(address);

    return new this(contract);
  };

  Contract.deployed = function() {
    if (!this.address) {
      throw new Error("Cannot find deployed address: Drone not deployed or address not set.");
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
            "name": "myid",
            "type": "bytes32"
          },
          {
            "name": "result",
            "type": "string"
          }
        ],
        "name": "__callback",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "myid",
            "type": "bytes32"
          },
          {
            "name": "result",
            "type": "string"
          },
          {
            "name": "proof",
            "type": "bytes"
          }
        ],
        "name": "__callback",
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
        "inputs": [],
        "name": "withdrawfunds",
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
        "name": "requestFlight",
        "outputs": [],
        "payable": true,
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
        "payable": false,
        "type": "constructor"
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
    "unlinked_binary": "0x606060405260008054600160a060020a03191633600160a060020a0316179055346100005760405161144238038061144283398101604090815281516020830151918301519092015b60038054600160a060020a03808616600160a060020a0319928316179092556004805492851692909116919091179055805160068054600082905290916020601f6002600185161561010002600019019094169390930483018190047ff652222313e28459528d920b65115c16c04f3efc82aaedc97be59f3f377c0d3f9081019390918601908390106100e657805160ff1916838001178555610113565b82800160010185558215610113579182015b828111156101135782518255916020019190600101906100f8565b5b506101349291505b80821115610130576000815560010161011c565b5090565b505060058054600160a060020a03191690555b5050505b6112e88061015a6000396000f300606060405236156100b45763ffffffff60e060020a60003504166306102d8281146100b957806306c81cc4146100d457806327dc297e146100fd57806338bbfa50146101535780634ac4eb70146101e657806357d98ff4146102735780635d225ff41461029c5780636c343ffe146102b75780637fa38734146102c65780638da5cb5b1461031b578063a1a0695214610344578063dea026911461035f578063e674566d146103b4578063e9b3a507146103be575b610000565b34610000576100d2600160a060020a03600435166103cd565b005b34610000576100e1610408565b60408051600160a060020a039092168252519081900360200190f35b346100005760408051602060046024803582810135601f81018590048502860185019096528585526100d2958335959394604494939290920191819084018382808284375094965061041795505050505050565b005b346100005760408051602060046024803582810135601f81018590048502860185019096528585526100d2958335959394604494939290920191819084018382808284375050604080516020601f89358b0180359182018390048302840183019094528083529799988101979196509182019450925082915084018382808284375094965061055095505050505050565b005b34610000576101f361055b565b604080516020808252835181830152835191928392908301918501908083838215610239575b80518252602083111561023957601f199092019160209182019101610219565b505050905090810190601f1680156102655780820380516001836020036101000a031916815260200191505b509250505060405180910390f35b34610000576100e16105e9565b60408051600160a060020a039092168252519081900360200190f35b34610000576100d2600160a060020a03600435166105f8565b005b34610000576100d2610782565b005b34610000576100d2600480803590602001908201803590602001908080601f016020809104026020016040519081016040528093929190818152602001838380828437509496506107da95505050505050565b005b34610000576100e1610896565b60408051600160a060020a039092168252519081900360200190f35b34610000576100d2600160a060020a03600435166108a5565b005b34610000576100d2600480803590602001908201803590602001908080601f016020809104026020016040519081016040528093929190818152602001838380828437509496506108e095505050505050565b005b6100d26109cd565b005b34610000576100d2610b3a565b005b60005433600160a060020a039081169116146103e857610000565b60038054600160a060020a031916600160a060020a0383161790555b5b50565b600554600160a060020a031681565b6000610421610bdb565b600160a060020a031633600160a060020a031614151561044057610000565b61044b826000610ce3565b905060328111156104dd5760055460408051600160a060020a039092168252602082018190526007828201527f72656675736564000000000000000000000000000000000000000000000000006060830152517fbd773aecdeb2262b1315e8bfb356b71bc09fa71ebb507fb2431a46b459f3c4469181900360800190a160058054600160a060020a0319169055610550565b60055460408051600160a060020a039092168252602082018190526008828201527f61636365707465640000000000000000000000000000000000000000000000006060830152517fbd773aecdeb2262b1315e8bfb356b71bc09fa71ebb507fb2431a46b459f3c4469181900360800190a15b505050565b5b505050565b6006805460408051602060026001851615610100026000190190941693909304601f810184900484028201840190925281815292918301828280156105e15780601f106105b6576101008083540402835291602001916105e1565b820191906000526020600020905b8154815290600101906020018083116105c457829003601f168201915b505050505081565b600354600160a060020a031681565b60005433600160a060020a0390811691161461061357610000565b600554600160a060020a03161561062957610000565b600480546040805160006020918201819052825160e060020a63babcc539028152600160a060020a03878116968201969096529251949093169363babcc539936024808501948390030190829087803b156100005760325a03f115610000575050604051516007805460ff1916911515919091179081905560ff16151590506106b157610000565b60058054600160a060020a031916600160a060020a0383161790556040805180820182526003815260ea60020a621554930260208083019190915260068054845160026101006001841615026000190190921691909104601f810184900484028201840190955284815261077c9490928301828280156107725780601f1061074757610100808354040283529160200191610772565b820191906000526020600020905b81548152906001019060200180831161075557829003601f168201915b5050505050610e18565b505b5b50565b60005433600160a060020a0390811691161461079d57610000565b60008054604051600160a060020a0391821692309092163180156108fc0292909190818181858888f1935050505015156107d657610000565b5b5b565b60005433600160a060020a039081169116146107f557610000565b8060069080519060200190828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f1061084157805160ff191683800117855561086e565b8280016001018555821561086e579182015b8281111561086e578251825591602001919060010190610853565b5b506105509291505b8082111561088b5760008155600101610877565b5090565b50505b5b50565b600054600160a060020a031681565b60005433600160a060020a039081169116146108c057610000565b60048054600160a060020a031916600160a060020a0383161790555b5b50565b60035433600160a060020a039081169116146108fb57610000565b60055460408051600160a060020a03909216808352602080840183815285519385019390935284517f5bfb828d47f71f756d57f79e394f9d67bbcd5dee4a8230643154ea90cc148e0b94929386939290916060840191850190808383821561097e575b80518252602083111561097e57601f19909201916020918201910161095e565b505050905090810190601f1680156109aa5780820380516001836020036101000a031916815260200191505b50935050505060405180910390a160058054600160a060020a03191690555b5b50565b600554600160a060020a0316156109e357610000565b600480546040805160006020918201819052825160e060020a63babcc539028152600160a060020a03338116968201969096529251949093169363babcc539936024808501948390030190829087803b156100005760325a03f115610000575050604051516007805460ff1916911515919091179081905560ff1615159050610a6b57610000565b60058054600160a060020a03191633600160a060020a03161790556040805180820182526003815260ea60020a621554930260208083019190915260068054845160026101006001841615026000190190921691909104601f81018490048402820184019095528481526104049490928301828280156107725780601f1061074757610100808354040283529160200191610772565b820191906000526020600020905b81548152906001019060200180831161075557829003601f168201915b5050505050610e18565b505b565b60005433600160a060020a03908116911614610b5557610000565b60055460408051600160a060020a039092168252602082018190526016828201527f73746174652072657365746564206279206f776e6572000000000000000000006060830152517f5bfb828d47f71f756d57f79e394f9d67bbcd5dee4a8230643154ea90cc148e0b9181900360800190a160058054600160a060020a03191690555b5b565b600154600090600160a060020a03161515610bfc57610bfa6000611114565b505b6001546040805160006020918201819052825160e060020a6338cc48310281529251600160a060020a03909416936338cc48319360048082019493918390030190829087803b156100005760325a03f11561000057505060408051805160028054600160a060020a031916600160a060020a0392831617908190556000602093840181905284517fc281d19e000000000000000000000000000000000000000000000000000000008152945191909216945063c281d19e9360048082019493918390030190829087803b156100005760325a03f115610000575050604051519150505b5b90565b6040805160208101909152600090819052828180805b8351811015610e0a57603060f860020a02848281518110156100005790602001015160f860020a900460f860020a02600160f860020a03191610158015610d6e5750603960f860020a02848281518110156100005790602001015160f860020a900460f860020a02600160f860020a03191611155b15610dc5578115610d8d57851515610d8557610e0a565b600019909501945b5b600a830292506030848281518110156100005790602001015160f860020a900460f860020a0260f860020a90040383019250610e00565b838181518110156100005790602001015160f860020a900460f860020a02600160f860020a031916602e60f860020a021415610e0057600191505b5b5b600101610cf9565b8294505b5050505092915050565b6001546000908190600160a060020a03161515610e3b57610e396000611114565b505b6001546040805160006020918201819052825160e060020a6338cc48310281529251600160a060020a03909416936338cc48319360048082019493918390030190829087803b156100005760325a03f11561000057505060408051805160028054600160a060020a031916600160a060020a039283161790819055600060209384015292517f524f38890000000000000000000000000000000000000000000000000000000081526004810183815289516024830152895194909216945063524f3889938993839260440191908501908083838215610f35575b805182526020831115610f3557601f199092019160209182019101610f15565b505050905090810190601f168015610f615780820380516001836020036101000a031916815260200191505b5092505050602060405180830381600087803b156100005760325a03f11561000057505060405151915050670de0b6b3a764000062030d403a0201811115610fac576000915061110c565b600260009054906101000a9004600160a060020a0316600160a060020a031663adf59f9982600087876000604051602001526040518563ffffffff1660e060020a028152600401808481526020018060200180602001838103835285818151815260200191508051906020019080838360008314611045575b80518252602083111561104557601f199092019160209182019101611025565b505050905090810190601f1680156110715780820380516001836020036101000a031916815260200191505b50838103825284518152845160209182019186019080838382156110b0575b8051825260208311156110b057601f199092019160209182019101611090565b505050905090810190601f1680156110dc5780820380516001836020036101000a031916815260200191505b50955050505050506020604051808303818588803b156100005761235a5a03f11561000057505060405151935050505b5b5092915050565b60006000611135731d3b2638a7cc9f2cb3d298a3da7a90b67e5506ed6112b4565b1115611167575060018054600160a060020a031916731d3b2638a7cc9f2cb3d298a3da7a90b67e5506ed1781556112af565b600061118673c03a2615d5efaf5f49f60b7bb6583eaec212fdf16112b4565b11156111b8575060018054600160a060020a03191673c03a2615d5efaf5f49f60b7bb6583eaec212fdf11781556112af565b60006111d77320e12a1f859b3feae5fb2a0a32c18f5a65555bbf6112b4565b1115611209575060018054600160a060020a0319167320e12a1f859b3feae5fb2a0a32c18f5a65555bbf1781556112af565b60006112287393bbbe5ce77034e3095f0479919962a903f898ad6112b4565b111561125a575060018054600160a060020a0319167393bbbe5ce77034e3095f0479919962a903f898ad1781556112af565b60006112797351efaf4c8b3c9afbd5ab9f4bbc82784ab6ef8faa6112b4565b11156112ab575060018054600160a060020a0319167351efaf4c8b3c9afbd5ab9f4bbc82784ab6ef8faa1781556112af565b5060005b919050565b803b5b9190505600a165627a7a72305820afab9826b072088ace7c1458c0190d90dc18bcce985455a2b652be4819cc6b300029",
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
    "updated_at": 1485632940714,
    "links": {}
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

  Contract.contract_name   = Contract.prototype.contract_name   = "Drone";
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
    window.Drone = Contract;
  }
})();
