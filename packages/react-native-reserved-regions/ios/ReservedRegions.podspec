Pod::Spec.new do |spec|
  spec.name             = 'ReservedRegions'
  spec.version          = '0.0.1'
  spec.summary          = 'Folds and camera cutouts as reserved regions'
  spec.author           = 'Pandoks_'
  spec.homepage         = 'https://github.com/Pandoks/pandoks.com'
  spec.platforms        = { :ios => '16.4' }
  spec.source           = { git: '' }
  spec.static_framework = true
  spec.dependency 'ExpoModulesCore'
  spec.source_files     = '**/*.swift'
end
