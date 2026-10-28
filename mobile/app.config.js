// API_BASE_URL (eas "local" profile) overrides the server and allows cleartext http.
module.exports = ({ config }) => {
  const apiBaseUrl = process.env.API_BASE_URL;
  if (!apiBaseUrl) return config;

  return {
    ...config,
    name: `${config.name} (Local)`,
    extra: { ...config.extra, apiBaseUrl },
    ios: {
      ...config.ios,
      infoPlist: {
        ...config.ios?.infoPlist,
        NSAppTransportSecurity: { NSAllowsArbitraryLoads: true },
        NSLocalNetworkUsageDescription: 'GeoAttend (Local) connects to the GeoAttend server on this network.',
      },
    },
    plugins: [
      ...(config.plugins || []),
      ['expo-build-properties', { android: { usesCleartextTraffic: true } }],
    ],
  };
};
