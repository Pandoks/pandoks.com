require "yaml"

pipeline = ".github/workflows/pipeline.yaml"
jobs = YAML.safe_load(File.read(pipeline)).fetch("jobs")
aggregates = jobs.select { |name, _| name.end_with?("-pass") }
block = File.read("infra/github.ts")[/requiredChecks:\s*\[(.*?)\]/m, 1] or
  abort "requiredChecks array not found in infra/github.ts"
required = block.scan(/['"]([^'"]+)['"]/).flatten
failed = "${{ contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled') }}"
gate = {
  "if" => "${{ always() }}",
  "runs-on" => "ubuntu-latest",
  "steps" => [{ "if" => failed, "run" => "exit 1" }]
}

abort "changes must run unconditionally" if jobs.fetch("changes").key?("if")

missing = required - aggregates.keys
abort "requiredChecks with no pipeline job: #{missing.join(', ')}" unless missing.empty?

aggregates.each do |name, job|
  abort "#{name} must directly need changes" unless Array(job["needs"]).include?("changes")
  abort "#{name} must be `needs` plus exactly:\n#{gate.to_yaml}" unless job.except("needs") == gate
end

covered = aggregates.values_at(*required).flat_map { |job| Array(job["needs"]) }
scheduled_only = jobs.select do |_, job|
  cond = job["if"].to_s.strip.sub(/\A\$\{\{\s*(.*?)\s*\}\}\z/m, '\1')
  cond.match?(/\Agithub\.event_name\s*==\s*['"]schedule['"]\z/)
end.keys
orphans = jobs.keys - aggregates.keys - covered - scheduled_only
abort "Jobs no required aggregate needs: #{orphans.join(', ')}" unless orphans.empty?
