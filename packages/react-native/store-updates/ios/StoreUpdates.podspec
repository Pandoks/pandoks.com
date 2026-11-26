Pod::Spec.new do |s|
  s.name             = 'StoreUpdates'
  s.version          = '0.0.1'
  s.summary          = 'App Store update checks'
  s.author           = 'Pandoks_'
  s.homepage         = 'https://github.com/Pandoks/pandoks.com'
  s.platforms        = { :ios => '16.4' }
  s.source           = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files     = '**/*.swift'
end
