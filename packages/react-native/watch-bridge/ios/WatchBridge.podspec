Pod::Spec.new do |s|
  s.name           = 'WatchBridge'
  s.version        = '0.0.1'
  s.summary        = 'Phone↔Apple-Watch messaging over WCSession.'
  s.description    = 'Phone↔watch messaging — Apple Watch (WCSession), Wear OS (Data Layer MessageClient).'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4',
  }
  s.source         = { git: '' }
  s.frameworks     = 'WatchConnectivity'
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
