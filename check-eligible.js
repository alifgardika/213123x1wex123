const fs = require("fs");
const { spawn } = require("child_process");
const path = require("path");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const logInfo = (message) => console.log(`\x1b[34m[INFO]\x1b[0m ${message}`);
const logSuccess = (message) => console.log(`\x1b[32m[GOOD]\x1b[0m ${message}`);
const logError = (message) => console.log(`\x1b[31m[FAIL]\x1b[0m ${message}`);
const logWarning = (message) => console.log(`\x1b[33m[WARN]\x1b[0m ${message}`);
const logMissing = (message) => console.log(`\x1b[35m[LOST]\x1b[0m ${message}`);

const formatTimestamp = (timestamp) => {
  const date = new Date(timestamp);
  const options = {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  };
  const formatted = new Intl.DateTimeFormat("en-GB", options).format(date);
  return formatted + " WIB";
};

const readNodesData = (filename) => {
  try {
    return fs
      .readFileSync(filename, "utf8")
      .trim()
      .split("\n")
      .map((line) => line.replace(/\r/g, ""))
      .filter((line) => line.trim() !== "");
  } catch (err) {
    logError(`Failed to read file: ${err.message}`);
    return null;
  }
};

const saveLogData = (filename, data) => {
  try {
    fs.writeFileSync(filename, data);
    return true;
  } catch (err) {
    logError(`Failed to save log file: ${err.message}`);
    return false;
  }
};

const getPublicIP = async () => {
  try {
    const res = await fetch("https://checkip.amazonaws.com/", {
      method: "GET",
      headers: {
        Accept: "text/plain",
        "User-Agent": "curl",
      },
    });

    if (!res.ok) {
      logError(`Failed to get IP (status: ${res.status})`);
      return null;
    }

    const ipv4 = (await res.text()).trim();
    return ipv4;
  } catch (err) {
    logError(`Error getting IP: ${err.message}`);
    return null;
  }
};

const getNodesStatus = async (ipv4) => {
  const API_URL = `https://incentive-backend.oceanprotocol.com/nodes?page=1&size=1000&search=${ipv4}`;

  try {
    const res = await fetch(API_URL, {
      headers: {
        accept: "application/json, text/plain, */*",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      },
    });

    if (!res.ok) {
      logError(`Failed to check node status (status: ${res.status})`);
      return null;
    }

    return await res.json();
  } catch (err) {
    logError(`Error checking node status: ${err.message}`);
    return null;
  }
};

let totalRestartedContainers = 0;

const restartDockerContainer = async (dockerPath) => {
  logInfo(`Processing container in ${dockerPath}...`);

  return new Promise((resolve) => {
    const dockerProcess = spawn(
      "docker",
      ["compose", "-f", `${dockerPath}/docker-compose.yml`, "restart"],
      { stdio: "inherit" }
    );

    dockerProcess.on("close", (code) => {
      if (code === 0) {
        logSuccess(`Container successfully restarted`);
        totalRestartedContainers++;
      } else {
        logError(`Container restart failed (code: ${code})`);
      }
      resolve(code);
    });
  });
};

async function main() {
  const FILES = {
    nodesData: "data-nodes.txt",
    dashboardLog: "log-dashboard-nodes.txt",
  };

  const checkInterval = (parseInt(process.argv[2]) || 15) * 60 * 1000;

  const RESTART_AFTER_CHECKS = 5; // Config restart missing node after this many checks

  let publicIP = null;
  while (!publicIP) {
    publicIP = await getPublicIP();
    if (!publicIP) await delay(2000);
  }

  console.clear();
  logInfo(`Public IP ${publicIP}`);

  let isFirstRun = true;

  const processedNodeStatus = {};
  const missingNodeCounters = {}; // Track how many times a node has been missing

  while (true) {
    const localNodes = readNodesData(FILES.nodesData);
    if (!localNodes || localNodes.length === 0) {
      logError(
        "Node data file is empty or invalid. Please check your node data.\n"
      );
      await delay(10 * 1000);
      continue;
    }

    logInfo(`Found ${localNodes.length} local node data`);

    let dashboardData = null;
    while (!dashboardData) {
      dashboardData = await getNodesStatus(publicIP);
      if (!dashboardData) await delay(2 * 1000);
    }

    const { nodes } = dashboardData;

    if (nodes.length === 0) {
      logWarning(`No nodes for IP ${publicIP} on Ocean dashboard\n`);
      // [DEPRECATED] Originally would skip when no dashboard nodes found
      // Now kept disabled to:
      // ✓ Track disappeared nodes
      // ✓ Compare with local nodes list
      // ✓ Trigger container restarts if needed
      // await delay(checkInterval);
      // continue;
    }

    let logContent = "";
    let notEligibleCount = 0;
    let processedNodes = [];
    let foundNodeIds = new Set();

    for (const node of nodes) {
      const nodeId = node._id;
      const isEligible = node._source.eligible;
      const lastCheckTime = node._source.lastCheck;
      const eligibilityCause = node._source.eligibilityCauseStr || "None";

      foundNodeIds.add(nodeId);

      if (!isEligible) notEligibleCount++;

      for (const localNodeData of localNodes) {
        const [dockerName, , localNodeId] = localNodeData.split("|");

        if (localNodeId === nodeId) {
          const nodeInfo = `${dockerName}|${nodeId}|${isEligible}|${lastCheckTime}|${eligibilityCause}`; // Tambahkan eligibilityCause
          logContent += `${nodeInfo}\n`;
          processedNodes.push({
            dockerName,
            nodeId,
            isEligible,
            lastCheckTime: lastCheckTime.toString(),
            eligibilityCause,
          });

          // Reset missing counter for nodes that are found
          const nodeKey = `${dockerName}-${localNodeId}`;
          if (missingNodeCounters[nodeKey]) {
            delete missingNodeCounters[nodeKey];
          }
        }
      }
    }

    const oldDashboardData = fs.existsSync(FILES.dashboardLog)
      ? readNodesData(FILES.dashboardLog)
      : [];

    const oldDataMap = {};
    if (oldDashboardData && oldDashboardData.length > 0) {
      for (const entry of oldDashboardData) {
        const parts = entry.split("|");
        if (parts.length >= 5) {
          const [dockerName, nodeId, , lastCheck] = parts;
          oldDataMap[nodeId] = { dockerName, lastCheck };
        }
      }
    }

    if (!fs.existsSync(FILES.dashboardLog)) {
      saveLogData(FILES.dashboardLog, logContent);
    }

    logInfo(`Found ${nodes.length} nodes on Ocean dashboard`);
    const eligibleCount = nodes.length - notEligibleCount;
    if (notEligibleCount > 0) {
      logWarning(`${eligibleCount} Eligible, ${notEligibleCount} Not Eligible`);
    } else {
      logSuccess(`All nodes are eligible (${eligibleCount})`);
    }

    const missingNodes = [];
    for (const localNodeData of localNodes) {
      const [dockerName, , localNodeId] = localNodeData.split("|");
      if (!foundNodeIds.has(localNodeId)) {
        missingNodes.push({
          dockerName,
          nodeId: localNodeId,
        });
      }
    }

    if (missingNodes.length > 0) {
      logWarning(
        `Found ${missingNodes.length} local nodes that are not on the dashboard!`
      );
    }

    for (const node of processedNodes) {
      if (!node.isEligible) {
        const readableTime = formatTimestamp(Number(node.lastCheckTime));
        console.log("\n" + "-".repeat(70));
        logInfo(`Container ${node.dockerName}`);
        logWarning(`Status ${node.eligibilityCause}`);
        logInfo(`Check time ${readableTime}`);

        const oldCheckTime = oldDataMap[node.nodeId]
          ? oldDataMap[node.nodeId].lastCheck
          : null;
        const isStatusChanged =
          oldCheckTime !== null && oldCheckTime !== node.lastCheckTime;
        const nodeKey = `${node.dockerName}-${node.nodeId}`;

        if (isFirstRun) {
          if (!processedNodeStatus[nodeKey]) {
            logInfo(`Trying to restart...`); // first run restart not elig
            processedNodeStatus[nodeKey] = node.lastCheckTime;

            if (fs.existsSync(node.dockerName)) {
              const dockerPath = path.resolve(node.dockerName);
              await restartDockerContainer(dockerPath);
            } else {
              logError(`Directory ${node.dockerName} not found!`);
            }
          }
        } else if (isStatusChanged) {
          const oldTime = formatTimestamp(Number(oldCheckTime));
          logInfo(`Previous check ${oldTime}`);
          logInfo(`New status update detected`);

          if (processedNodeStatus[nodeKey] !== node.lastCheckTime) {
            logInfo(`Trying to restart...`);
            processedNodeStatus[nodeKey] = node.lastCheckTime;

            if (fs.existsSync(node.dockerName)) {
              const dockerPath = path.resolve(node.dockerName);
              await restartDockerContainer(dockerPath);
            } else {
              logError(`Directory ${node.dockerName} not found!`);
            }
          } else {
            logInfo(`Container already restarted for this update`);
          }
        } else {
          logInfo(`No new updates. Waiting for update...`);
        }
        console.log("-".repeat(70));
      }
    }

    for (const missingNode of missingNodes) {
      const nodeKey = `${missingNode.dockerName}-${missingNode.nodeId}`;
      console.log("\n" + "-".repeat(70));
      logInfo(`Container ${missingNode.dockerName}`);
      logInfo(`Node disappear on dashboard`);
      logMissing(`Node ID ${missingNode.nodeId}`);

      // Initialize or increment counter for missing node
      if (!missingNodeCounters[nodeKey]) {
        missingNodeCounters[nodeKey] = 1;
      } else {
        missingNodeCounters[nodeKey]++;
      }

      // Check if we should restart based on initial status or counter
      const shouldRestart =
        !processedNodeStatus[nodeKey] ||
        processedNodeStatus[nodeKey] !== "missing" ||
        missingNodeCounters[nodeKey] >= RESTART_AFTER_CHECKS;

      if (shouldRestart) {
        if (
          !processedNodeStatus[nodeKey] ||
          processedNodeStatus[nodeKey] !== "missing"
        ) {
          logInfo(`Trying to restart...`); // first restart missing node
        } else {
          logInfo(
            `Node has been missing for ${missingNodeCounters[nodeKey]} checks, trying to restart again...`
          );
        }

        processedNodeStatus[nodeKey] = "missing";
        missingNodeCounters[nodeKey] = 0; // Reset counter after restart

        if (fs.existsSync(missingNode.dockerName)) {
          const dockerPath = path.resolve(missingNode.dockerName);
          await restartDockerContainer(dockerPath);
        } else {
          logError(`Directory ${missingNode.dockerName} not found!`);
        }
      } else {
        logWarning(
          `Check ${missingNodeCounters[nodeKey]}/${RESTART_AFTER_CHECKS} before next restart`
        );
      }
      console.log("-".repeat(70));
    }

    isFirstRun = false;

    saveLogData(FILES.dashboardLog, logContent);

    const nextCheckTime = formatTimestamp(Date.now() + checkInterval);
    const minutes = checkInterval / (60 * 1000);

    console.log();
    if (totalRestartedContainers !== 0) {
      logSuccess(`Success restarted ${totalRestartedContainers} containers`);
    }
    logInfo(`Next check ${nextCheckTime}`);
    logInfo(`Waiting ${minutes} minutes...\n`);

    totalRestartedContainers = 0;
    await delay(checkInterval);
  }
}

main();
