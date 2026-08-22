// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {Monadrift} from "../src/Monadrift.sol";

/// Usage (see PROJECT.md §16 / monad-hackathon skill for RPC + keystore setup):
///   forge script script/Deploy.s.sol --account monad-deployer --broadcast --rpc-url monad_testnet
/// TREASURY env var defaults to the deployer if unset.
contract Deploy is Script {
    function run() external returns (Monadrift) {
        address treasury = vm.envOr("TREASURY", msg.sender);
        vm.startBroadcast();
        Monadrift m = new Monadrift(treasury);
        vm.stopBroadcast();
        console.log("Monadrift deployed at:", address(m));
        console.log("Treasury:", treasury);
        return m;
    }
}
