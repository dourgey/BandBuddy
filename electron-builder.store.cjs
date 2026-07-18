module.exports = {
  extends: './electron-builder.yml',
  forceCodeSigning: false,
  directories: {
    output: 'release-store'
  },
  win: {
    target: [{ target: 'appx', arch: ['x64'] }]
  },
  appx: {
    applicationId: 'BandBuddy',
    identityName: 'LonelyMePort.BandBuddy',
    publisher: 'CN=950A989F-7A64-427F-B3FF-1138BF3C24C8',
    publisherDisplayName: 'LonelyMePort',
    displayName: 'BandBuddy',
    languages: ['zh-CN', 'en-US'],
    minVersion: '10.0.19041.0',
    maxVersionTested: '10.0.26100.0',
    showNameOnTiles: true
  }
}
