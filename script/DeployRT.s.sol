// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {MonadriftRT} from "../src/MonadriftRT.sol";

/// forge script script/DeployRT.s.sol --account <keystore> --broadcast --rpc-url monad_testnet
/// TREASURY defaults to the deployer; OPERATOR defaults to the deployer. Set OPERATOR to the
/// address of the key the backend will use (RT_OPERATOR_PRIVATE_KEY, or the funder).
contract DeployRT is Script {
    function run() external returns (MonadriftRT) {
        address treasury = vm.envOr("TREASURY", msg.sender);
        address operator = vm.envOr("OPERATOR", msg.sender);
        vm.startBroadcast();
        MonadriftRT m = new MonadriftRT(treasury, operator);
        vm.stopBroadcast();
        console.log("MonadriftRT deployed at:", address(m));
        console.log("Treasury:", treasury);
        console.log("Operator:", operator);
        return m;
    }
}
