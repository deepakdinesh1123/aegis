export default {
  testEnvironment: "node",
  maxWorkers: 1,
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        useESM: true,
        tsconfig: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          isolatedModules: true,
          esModuleInterop: true,
          types: ["node", "jest"],
        },
      },
    ],
  },
};
