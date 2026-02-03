// Other imports at the top of the module
import * as containerinstance from '@pulumi/azure-native/containerinstance';
// import * as dockerBuild from '@pulumi/docker-build'   <-- CHANGE: we no longer need this
import * as cache from '@pulumi/azure-native/cache';
import * as containerregistry from '@pulumi/azure-native/containerregistry';
import * as resources from '@pulumi/azure-native/resources';
import * as pulumi from "@pulumi/pulumi";

// Import the configuration settings for the current stack.
const config = new pulumi.Config()
const appPath = config.require('appPath')
const prefixName = config.require('prefixName')
const imageName = prefixName
const imageTag = config.require('imageTag')
// Azure container instances (ACI) service does not yet support port mapping
// so, the containerPort and publicPort must be the same
const containerPort = config.requireNumber('containerPort')
const publicPort = config.requireNumber('publicPort')
const cpu = config.requireNumber('cpu')
const memory = config.requireNumber('memory')

// Create a resource group.
const resourceGroup = new resources.ResourceGroup(`${prefixName}-rg`)

// Create the container registry.
const registry = new containerregistry.Registry(`${prefixName}ACR`, {
  resourceGroupName: resourceGroup.name,
  adminUserEnabled: true,
  sku: {
    name: containerregistry.SkuName.Basic,
  },
})

// Get the authentication credentials for the container registry.
const registryCredentials = containerregistry
  .listRegistryCredentialsOutput({
    resourceGroupName: resourceGroup.name,
    registryName: registry.name,
  })
  .apply((creds) => {
    return {
      username: creds.username!,
      password: creds.passwords![0].value!,
    }
  })

// --- CHANGE 1: Skip Pulumi Docker build completely ---
// We will reference the prebuilt image in ACR instead
// const image = new dockerBuild.Image(`${prefixName}-image`, {
//   tags: [pulumi.interpolate`${registry.loginServer}/${imageName}:${imageTag}`],
//   context: { location: appPath },
//   dockerfile: { location: `${appPath}/Dockerfile` },
//   target: 'production',
//   platforms: ['linux/amd64', 'linux/arm64'],
//   push: true,
//   registries: [
//     {
//       address: registry.loginServer,
//       username: registryCredentials.username,
//       password: registryCredentials.password,
//     },
//   ],
// })



// Create a managed Redis service
const redis = new cache.Redis(`${prefixName}-redis`, {
  name: `${prefixName}-weather-cache`,
  location: 'westus3',
  resourceGroupName: resourceGroup.name,
  enableNonSslPort: true,
  redisVersion: 'Latest',
  minimumTlsVersion: '1.2',
  redisConfiguration: {
    maxmemoryPolicy: 'allkeys-lru'
  },
  sku: {
    name: 'Basic',
    family: 'C',
    capacity: 0
  }
})

const redisAccessKey = cache
  .listRedisKeysOutput({ name: redis.name, resourceGroupName: resourceGroup.name })
  .apply(keys => keys.primaryKey)

// --- CHANGE 2: Create a variable with the prebuilt image reference ---
const prebuiltImageName = pulumi.interpolate`${registry.loginServer}/${imageName}:${imageTag}`
const redisConnectionString = pulumi.interpolate`rediss://:${redisAccessKey}@${redis.hostName}:${redis.sslPort}`

// Create a container group in the Azure Container App service and make it publicly accessible.
const containerGroup = new containerinstance.ContainerGroup(
  `${prefixName}-container-group`,
  {
    resourceGroupName: resourceGroup.name,
    osType: 'linux',
    restartPolicy: 'always',
    imageRegistryCredentials: [
      {
        server: registry.loginServer,
        username: registryCredentials.username,
        password: registryCredentials.password,
      },
    ],
    containers: [
      {
        name: imageName,
        image: prebuiltImageName, // --- CHANGE 3: reference the prebuilt image instead of dockerBuild.Image.ref
        ports: [
          {
            port: containerPort,
            protocol: 'tcp',
          },
        ],
        environmentVariables: [
          {
            name: 'PORT',
            value: containerPort.toString(),
          },
          {
            name: 'WEATHER_API_KEY',
            value: config.requireSecret('weatherApiKey'),
          },
          {
            name: 'REDIS_URL',
            value: redisConnectionString
          },
        ],
        resources: {
          requests: {
            cpu: cpu,
            memoryInGB: memory,
          },
        },
      },
    ],
    ipAddress: {
      type: containerinstance.ContainerGroupIpAddressType.Public,
      dnsNameLabel: `${imageName}`,
      ports: [
        {
          port: publicPort,
          protocol: 'tcp',
        },
      ],
    },
  },
)

// Export the service's IP address, hostname, and fully-qualified URL.
export const hostname = containerGroup.ipAddress.apply((addr) => addr!.fqdn!)
export const ip = containerGroup.ipAddress.apply((addr) => addr!.ip!)
export const url = containerGroup.ipAddress.apply(
  (addr) => `http://${addr!.fqdn!}:${containerPort}`,
)
