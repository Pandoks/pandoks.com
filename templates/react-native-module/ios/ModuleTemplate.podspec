Pod::Spec.new do |spec|
  spec.name             = 'ModuleTemplate'
  spec.version          = '0.0.1'
  spec.summary          = 'Expo module template'
  spec.author           = 'Pandoks_'
  spec.homepage         = 'https://github.com/Pandoks/pandoks.com'
  spec.platforms        = { :ios => '16.4' }
  spec.source           = { git: '' }
  spec.static_framework = true
  spec.dependency 'ExpoModulesCore'
  spec.source_files     = '**/*.swift'
end
