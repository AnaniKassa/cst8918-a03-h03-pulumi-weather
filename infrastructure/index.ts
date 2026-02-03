import * as containerinstance from '@pulumi/azure-native/containerinstance';
import * as containerregistry from '@pulumi/azure-native/containerregistry';
import * as cache from '@pulumi/azure-native/redis';
import * as resources from '@pulumi/azure-native/resources';
import * as pulumi from "@pulumi/pulumi";

// Load stack configuration
const config = new pulumi.Config();
const appPath = config.require('appPath');
const prefixName = config.require('prefixName');
const imageName = prefixName;
const imageTag = config.require('imageTag');

const containerPort = config.requireNumber('containerPort');
const publicPort = config.requireNumber('publicPort');
const cpu = config.requireNumber('cpu');
const memory = config.requireNumber('memory');

// Create resource group
const resourceGroup = new resources.ResourceGroup(`${prefixName}-rg`);

// Create Azure Container Registry
const registry = new containerregistry.Registry(`${prefixName}ACR`, {
    resourceGroupName: resourceGroup.name,
    adminUserEnabled: true,
    sku: { name: containerregistry.SkuName.Basic },
});

// Retrieve ACR credentials
const registryCredentials = containerregistry
    .listRegistryCredentialsOutput({
        resourceGroupName: resourceGroup.name,
        registryName: registry.name,
    })
    .apply(creds => ({
        username: creds.username!,
        password: creds.passwords![0].value!,
    }));

// Reference the prebuilt image already pushed to ACR
const prebuiltImageName = pulumi.interpolate`${registry.loginServer}/${imageName}:${imageTag}`;

// Create Redis instance
const redis = new cache.Redis(`${prefixName}-redis`, {
    name: `${prefixName}-weather-cache`,
    location: "westus3",
    resourceGroupName: resourceGroup.name,
    enableNonSslPort: true,
    redisVersion: "Latest",
    minimumTlsVersion: "1.2",
    redisConfiguration: {
        maxmemoryPolicy: "allkeys-lru",
    },
    sku: {
        name: "Basic",
        family: "C",
        capacity: 0,
    },
});

// Redis connection string
const redisAccessKey = cache
    .listRedisKeysOutput({
        name: redis.name,
        resourceGroupName: resourceGroup.name,
    })
    .apply(keys => keys.primaryKey);

const redisConnectionString = pulumi.interpolate`rediss://:${redisAccessKey}@${redis.hostName}:${redis.sslPort}`;

// Deploy container group using the prebuilt image
const containerGroup = new containerinstance.ContainerGroup(
    `${prefixName}-container-group`,
    {
        resourceGroupName: resourceGroup.name,
        osType: "linux",
        restartPolicy: "always",
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
                image: prebuiltImageName,
                ports: [{ port: containerPort, protocol: "tcp" }],
                environmentVariables: [
                    { name: "PORT", value: containerPort.toString() },
                    { name: "WEATHER_API_KEY", value: config.requireSecret("weatherApiKey") },
                    { name: "REDIS_URL", value: redisConnectionString },
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
            ports: [{ port: publicPort, protocol: "tcp" }],
        },
    }
);

// Export outputs
export const hostname = containerGroup.ipAddress.apply(addr => addr!.fqdn!);
export const ip = containerGroup.ipAddress.apply(addr => addr!.ip!);
export const url = containerGroup.ipAddress.apply(addr => `http://${addr!.fqdn!}:${containerPort}`);
