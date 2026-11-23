require "yaml"

jobs = YAML.unsafe_load_file(".github/workflows/pipeline.yaml").fetch("jobs")
aggregates = jobs.select { |name, _| name.end_with?("-pass") }
github = File.read("infra/github.ts").gsub(%r{//.*}, "")
required = github[/requiredChecks: \[(.*?)\]/m, 1].scan(/'(.*?)'/).flatten
failed = "${{ contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled') }}"
gate = {
  "if" => "${{ always() }}",
  "runs-on" => "ubuntu-latest",
  "steps" => [{ "if" => failed, "run" => "exit 1" }]
}

unless aggregates.keys.sort == required.sort
  abort "Aggregates #{aggregates.keys} differ from requiredChecks #{required} in infra/github.ts"
end

aggregates.each do |name, job|
  abort "#{name} must directly need changes" unless Array(job["needs"]).include?("changes")
  abort "#{name} must be `needs` plus exactly:\n#{gate.to_yaml}" unless job.except("needs") == gate
end

orphans = jobs.keys - aggregates.keys - aggregates.values.flat_map { |job| Array(job["needs"]) }
abort "Orphan pipeline jobs: #{orphans.join(', ')}" unless orphans.empty?
