require "yaml"

jobs = YAML.safe_load_file(".github/workflows/pipeline.yaml", aliases: true).fetch("jobs")
aggregates = jobs.select { |name, _| name.end_with?("-pass") }
required = File.read("infra/github.ts")[/requiredChecks: \[(.*?)\]/m, 1].scan(/'(.*?)'/).flatten
failed = "${{ contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled') }}"
gate = ["${{ always() }}", [{ "if" => failed, "run" => "exit 1" }]]

unless aggregates.keys.sort == required.sort
  abort "Aggregates #{aggregates.keys} differ from requiredChecks #{required} in infra/github.ts"
end

aggregates.each do |name, job|
  abort "#{name} must directly need changes" unless Array(job["needs"]).include?("changes")
  next if job.values_at("if", "steps") == gate
  abort "#{name} needs `if: #{gate[0]}` and only the step that exits 1 when `#{failed}`"
end

orphans = jobs.keys - aggregates.keys - aggregates.values.flat_map { |job| Array(job["needs"]) }
abort "Orphan pipeline jobs: #{orphans.join(', ')}" unless orphans.empty?
